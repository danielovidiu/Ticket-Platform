/**
 * The retry policy, which is the whole reason this module exists.
 *
 * The rule under test: a failure is only retried when retrying could plausibly change
 * the answer. A 413 changes it by sending fewer bytes, a dropped connection by trying
 * again, and a 400 not at all — so a rejected file must fail once and say why, rather
 * than costing three attempts to arrive at the same sentence.
 */
import { classify, describe as explain, uploadOne, runPipeline, STAGE, MAX_ATTEMPTS } from "./uploadPipeline";

// An axios-shaped rejection. `status: 0` stands for "no response at all".
const httpError = (status, detail) => ({
  response: status ? { status, data: detail ? { detail } : {} } : undefined,
});

// The pipeline only reprocesses images, and jsdom cannot decode one — a plain
// non-image File therefore travels through untouched, which keeps these tests about
// the policy rather than about canvas.
const someFile = () => new File([new Uint8Array(16)], "x.bin", { type: "application/octet-stream" });

describe("what deserves another attempt", () => {
  test.each([
    ["a dropped connection", 0],
    ["a request timeout", 408],
    ["a rate limit", 429],
    ["a server error", 500],
    ["a bad gateway", 502],
  ])("%s is retried", (_label, status) => {
    expect(classify(httpError(status))).toBe("retry");
  });

  test("a body the platform refused for its size asks for fewer bytes, not another attempt", () => {
    expect(classify(httpError(413))).toBe("shrink");
  });

  test.each([
    ["an unsupported type", 400],
    ["a lost session", 401],
    ["the wrong role", 403],
    ["a missing album", 404],
  ])("%s is fatal", (_label, status) => {
    expect(classify(httpError(status))).toBe("fatal");
  });
});

describe("what the editor is told", () => {
  test("the server's own words win", () => {
    expect(explain(httpError(400, "Choose a video — use the image block for stills")))
      .toBe("Choose a video — use the image block for stills");
  });

  test("a bare failure still names a cause", () => {
    expect(explain(httpError(0))).toBe("Connection lost");
    expect(explain(httpError(413))).toBe("Too large to send");
    expect(explain(httpError(503))).toBe("Server error");
  });
});

describe("uploadOne", () => {
  test("a transient failure is retried and can still succeed", async () => {
    let calls = 0;
    const send = async () => {
      calls++;
      if (calls < 3) throw httpError(500);
      return { url: "/uploads/ok.jpg" };
    };
    const result = await uploadOne(someFile(), { send });

    expect(calls).toBe(3);
    expect(result.ok).toBe(true);
    expect(result.data.url).toBe("/uploads/ok.jpg");
  });

  test("a fatal failure is not retried, and reports what the server said", async () => {
    let calls = 0;
    const send = async () => { calls++; throw httpError(400, "That file is not a readable image"); };
    const result = await uploadOne(someFile(), { send });

    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("That file is not a readable image");
  });

  test("a transient failure gives up rather than trying forever", async () => {
    let calls = 0;
    const send = async () => { calls++; throw httpError(500); };
    const result = await uploadOne(someFile(), { send });

    expect(calls).toBe(MAX_ATTEMPTS);
    expect(result.ok).toBe(false);
  });

  test("the stages an editor sees end in the outcome", async () => {
    const seen = [];
    await uploadOne(someFile(), {
      send: async () => ({ url: "/uploads/ok.jpg" }),
      onStage: (stage) => seen.push(stage),
    });
    expect(seen).toContain(STAGE.UPLOADING);
    expect(seen[seen.length - 1]).toBe(STAGE.DONE);
  });

  test("a retry is visible as a retry, not as a stall", async () => {
    const seen = [];
    let calls = 0;
    await uploadOne(someFile(), {
      send: async () => { calls++; if (calls === 1) throw httpError(500); return { url: "/u.jpg" }; },
      onStage: (stage, meta) => seen.push([stage, meta?.attempt]),
    });
    expect(seen).toContainEqual([STAGE.WAITING, 1]);
    expect(seen).toContainEqual([STAGE.UPLOADING, 2]);
  });
});

describe("runPipeline", () => {
  test("results keep the order the files were dropped in, however they interleave", async () => {
    const files = ["a", "b", "c", "d", "e"].map(
      (n) => new File([new Uint8Array(4)], `${n}.bin`, { type: "application/octet-stream" })
    );
    // Finish in a deliberately scrambled order.
    const delay = { "a.bin": 40, "b.bin": 5, "c.bin": 30, "d.bin": 1, "e.bin": 20 };
    const send = async (f) => {
      await new Promise((r) => setTimeout(r, delay[f.name]));
      return { url: f.name };
    };

    const results = await runPipeline(files, { send, concurrency: 3 });
    expect(results.map((r) => r.data.url)).toEqual(["a.bin", "b.bin", "c.bin", "d.bin", "e.bin"]);
  });

  test("one file failing does not take the batch with it", async () => {
    const files = [0, 1, 2].map((i) => new File([new Uint8Array(4)], `${i}.bin`, { type: "application/octet-stream" }));
    const send = async (f) => {
      if (f.name === "1.bin") throw httpError(400, "nope");
      return { url: f.name };
    };

    const results = await runPipeline(files, { send, concurrency: 2 });
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[1].message).toBe("nope");
  });
});

describe("files that cannot be made smaller", () => {
  const bigVideo = () => new File([new Uint8Array(32)], "clip.mp4", { type: "video/mp4" });
  const bigGif = () => new File([new Uint8Array(32)], "loop.gif", { type: "image/gif" });

  test.each([
    ["a video, which a browser cannot transcode", bigVideo],
    ["a GIF, which would lose its animation", bigGif],
  ])("%s fails a rejected body once instead of retrying", async (_label, make) => {
    let calls = 0;
    const send = async () => { calls++; throw httpError(413); };
    const result = await uploadOne(make(), { send });

    // The shrink path has nothing to offer here, so a second attempt would send
    // identical bytes to an identical refusal.
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Too large to send — compress it first");
  });

  test("an image is shrunk and resent instead", async () => {
    // jsdom cannot re-encode, so the bytes do not actually change — what is pinned here
    // is that an image is given the extra attempts a video is not.
    let calls = 0;
    const send = async () => { calls++; throw httpError(413); };
    const photo = new File([new Uint8Array(32)], "photo.jpg", { type: "image/jpeg" });
    const result = await uploadOne(photo, { send });

    expect(calls).toBeGreaterThan(1);
    expect(result.message).toBe("Too large to send");
  });
});

describe("a refusal decided in the browser", () => {
  const refusal = (message) => {
    const error = new Error(message);
    error.refusedLocally = true;
    return error;
  };

  test("is fatal, not a retry", () => {
    // It has no `response`, so it used to land on `code === 0` alongside a genuinely
    // dropped connection and be retried three times for nothing.
    expect(classify(refusal("too big"))).toBe("fatal");
  });

  test("keeps its own message", () => {
    // The sentence names the file's size and the limit it exceeded. "Connection lost"
    // replaced it with something both wrong and unactionable.
    expect(explain(refusal("That video is 120MB — the limit is 100MB.")))
      .toBe("That video is 120MB — the limit is 100MB.");
  });

  test("an ordinary network error is still a retry", () => {
    // The guard must not swallow the case it sits next to.
    expect(classify(new Error("boom"))).toBe("retry");
    expect(explain(new Error("boom"))).toBe("Connection lost");
  });
});
