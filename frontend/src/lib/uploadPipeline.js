/**
 * The upload pipeline: process locally, send, and try again when trying again is what
 * the failure calls for.
 *
 * It replaces a plain `Promise.all` of POSTs whose only error handling was to count how
 * many didn't make it. That produced the report an editor actually saw — "4 files
 * failed", no reason, no way to act on it except dropping all twenty again and hoping.
 *
 * Three things are separated here on purpose:
 *
 *   * the STAGE a file is in, so a slow re-encode doesn't look like a stalled upload;
 *   * WHY it failed, because a 413 and a dropped connection deserve different answers;
 *   * WHOSE job the retry is — automatic for anything transient, the editor's for
 *     anything that will fail identically the next time.
 */
import { processImage, needsProcessing, isProcessableImage, MAX_EDGE, QUALITY } from "./imagePipeline";

export const STAGE = {
  QUEUED: "queued",
  PROCESSING: "processing",
  UPLOADING: "uploading",
  WAITING: "waiting",   // between attempts
  DONE: "done",
  FAILED: "failed",
};

/** Three attempts total. A fourth adds latency an editor can feel and almost never
 * turns a failure into a success — by then the cause is not transient. */
export const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [400, 1600];

/** Each shrink step after a rejected body. Smaller and cheaper each time; the last is
 * small enough to survive any body limit a request is likely to meet. */
const SHRINK_STEPS = [
  { maxEdge: MAX_EDGE, quality: QUALITY },
  { maxEdge: 1920, quality: 0.75 },
  { maxEdge: 1280, quality: 0.7 },
];

const status = (err) => err?.response?.status ?? 0;

/**
 * What to do about a failed attempt.
 *
 *   "shrink" — the body was refused for its size. Re-encode harder and send again;
 *              this is the case the whole module exists for.
 *   "retry"  — nothing about the file is wrong. A dropped connection, a cold start, a
 *              rate limit, a 5xx.
 *   "fatal"  — the server looked at it and said no. Sending the same bytes again gets
 *              the same answer, so stop and show what it said.
 */
export function classify(error) {
  const code = status(error);
  if (code === 413) return "shrink";
  if (code === 0 || code === 408 || code === 429 || code >= 500) return "retry";
  return "fatal";
}

/** What to put in front of a person. Server-supplied detail wins — it is written for
 * this exact case — and the fallbacks name a cause rather than restating "failed".
 *
 * `file` is optional and only changes the "too large" case, where the useful half of the
 * sentence is whether anything can be done about it here. */
export function describe(error, file = null) {
  const detail = error?.response?.data?.detail;
  if (typeof detail === "string" && detail) return detail;
  const code = status(error);
  if (code === 413) {
    // A video cannot be transcoded in a browser and a GIF would lose its animation, so
    // there is no smaller version to offer — say so instead of implying a retry helps.
    return file && !isProcessableImage(file)
      ? "Too large to send — compress it first"
      : "Too large to send";
  }
  if (code === 429) return "Rate limited";
  if (code >= 500) return "Server error";
  if (code === 0) return "Connection lost";
  return `Failed (${code})`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One file, start to finish. `send` does the actual POST and is injected so the policy
 * above can be tested without a network.
 */
export async function uploadOne(file, { send, onStage = () => {} }) {
  let step = 0;
  let prepared = null;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Processing is deferred to here rather than done up front, so that a shrink can
    // redo it at a smaller size without a second code path.
    if (!prepared || step > 0) {
      onStage(STAGE.PROCESSING, { attempt });
      prepared = needsProcessing(file) || step > 0
        ? await processImage(file, SHRINK_STEPS[Math.min(step, SHRINK_STEPS.length - 1)])
        : file;
    }

    onStage(STAGE.UPLOADING, { attempt });
    try {
      const data = await send(prepared);
      onStage(STAGE.DONE, { attempt });
      return { ok: true, data };
    } catch (error) {
      lastError = error;
      const verdict = classify(error);

      if (verdict === "fatal" || attempt === MAX_ATTEMPTS) break;

      if (verdict === "shrink") {
        // Nothing to shrink, or nothing smaller left to try. Either way the next attempt
        // would send identical bytes to an identical refusal, so stop rather than spend
        // two more round trips arriving at the same answer.
        if (!isProcessableImage(file) || step >= SHRINK_STEPS.length - 1) break;
        step++;
      }

      onStage(STAGE.WAITING, { attempt, error });
      await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
    }
  }

  const message = describe(lastError, file);
  onStage(STAGE.FAILED, { error: lastError, message });
  return { ok: false, error: lastError, message };
}

/**
 * Run `files` through the pipeline, `concurrency` at a time, and return results in the
 * ORIGINAL order however the parallelism interleaves — the order an editor dropped them
 * in is the order they should end up in the album.
 */
export async function runPipeline(files, { send, concurrency = 3, onUpdate = () => {} }) {
  const results = new Array(files.length).fill(null);
  let cursor = 0;

  const worker = async () => {
    while (cursor < files.length) {
      const i = cursor++;
      results[i] = await uploadOne(files[i], {
        send,
        onStage: (stage, meta) => onUpdate(i, stage, meta),
      });
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, files.length)) }, worker)
  );
  return results;
}
