/**
 * Which files get re-encoded before they are sent.
 *
 * The decode itself needs a real canvas, which jsdom has not got — so what is pinned
 * here is the decision, and the guarantee wrapped around it: `processImage` returns the
 * original file rather than throwing when it cannot do its job. An upload must never
 * fail because the optimisation failed.
 */
import { isProcessableImage, needsProcessing, processImage, PROCESS_ABOVE_BYTES } from "./imagePipeline";

const fileOf = (type, bytes, name = "photo") =>
  new File([new Uint8Array(bytes)], name, { type });

describe("what gets processed", () => {
  test("a big photo does", () => {
    expect(needsProcessing(fileOf("image/jpeg", PROCESS_ABOVE_BYTES + 1))).toBe(true);
  });

  test("a small one is left exactly as it is", () => {
    // Re-encoding here would spend quality to solve a problem the file does not have.
    expect(needsProcessing(fileOf("image/jpeg", 1024))).toBe(false);
  });

  test("an animated GIF is never touched, whatever its size", () => {
    // A canvas holds one frame, so re-encoding would silently flatten the animation.
    expect(isProcessableImage(fileOf("image/gif", 9e6))).toBe(false);
    expect(needsProcessing(fileOf("image/gif", 9e6))).toBe(false);
  });

  test("video is not this module's job", () => {
    expect(isProcessableImage(fileOf("video/mp4", 9e6))).toBe(false);
  });

  test("a format the browser may not decode is still offered to it", () => {
    // HEIC off an iPhone: Safari can decode one and it becomes uploadable, Chrome
    // cannot and the original goes up to meet the server's own error message.
    expect(isProcessableImage(fileOf("image/heic", 9e6))).toBe(true);
  });
});

describe("failure costs the upload nothing", () => {
  test("a file the browser cannot decode comes back untouched", async () => {
    // jsdom has no createImageBitmap, so this exercises the real failure path.
    const original = fileOf("image/jpeg", 4096, "undecodable.jpg");
    const out = await processImage(original);
    expect(out).toBe(original);
  });

  test("a non-image is returned without being looked at", async () => {
    const original = fileOf("video/mp4", 4096, "clip.mp4");
    expect(await processImage(original)).toBe(original);
  });
});
