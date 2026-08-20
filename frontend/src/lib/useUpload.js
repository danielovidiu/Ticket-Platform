import { useCallback, useRef, useState } from "react";
import { uploadOne, STAGE } from "./uploadPipeline";

/**
 * One file, uploaded through the pipeline, for the single-slot fields.
 *
 * Same policy the album manager gets — local downscaling, backoff on transient
 * failures, no retry on a refusal the server will repeat — minus the queue, because
 * these fields hold exactly one file and a queue of one is furniture.
 *
 * The failed file is kept so a retry costs a click rather than reopening the picker.
 */
export function useSingleUpload({ send, onDone, accept }) {
  const [stage, setStage] = useState(null);
  const [attempt, setAttempt] = useState(1);
  const [error, setError] = useState(null);
  const lastFile = useRef(null);

  const busy = stage != null && stage !== STAGE.DONE && stage !== STAGE.FAILED;

  const start = useCallback(async (file) => {
    if (!file) return;

    // Checked here rather than after the upload: the old flow stored the bytes, then
    // noticed the media type was wrong and abandoned them, leaving a file in the blob
    // store with nothing pointing at it. The server still enforces this — the point of
    // doing it early is not to trust the browser, it is not to upload for nothing.
    if (accept && !file.type.startsWith(accept.prefix)) {
      setStage(STAGE.FAILED);
      setError(accept.message);
      lastFile.current = null;
      return;
    }

    lastFile.current = file;
    setError(null);

    const result = await uploadOne(file, {
      send,
      onStage: (s, meta) => { setStage(s); setAttempt(meta?.attempt ?? 1); },
    });

    if (result.ok) {
      lastFile.current = null;
      onDone(result.data);
    } else {
      setError(result.message);
    }
  }, [send, onDone, accept]);

  const retry = useCallback(() => {
    if (lastFile.current) start(lastFile.current);
  }, [start]);

  const dismiss = useCallback(() => {
    setStage(null);
    setError(null);
    lastFile.current = null;
  }, []);

  return {
    busy,
    error,
    /** Only offer a retry when there is something to retry — a file rejected for its
     * type never made it into the ref, and resending it would fail identically. */
    canRetry: !!error && !!lastFile.current,
    label: busy ? stageLabel(stage, attempt) : null,
    start,
    retry,
    dismiss,
  };
}

function stageLabel(stage, attempt) {
  const suffix = attempt > 1 ? ` ${attempt}` : "";
  if (stage === STAGE.PROCESSING) return `resizing${suffix}`;
  if (stage === STAGE.WAITING) return `retrying${suffix}`;
  if (stage === STAGE.UPLOADING) return `uploading${suffix}`;
  return "…";
}
