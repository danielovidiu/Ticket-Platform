/**
 * Which way a video file goes, and why there are two ways.
 *
 * On Vercel the platform refuses a request body over about 4.5 MB before the API is
 * reached, so a video of any real length cannot be posted to it — the browser has to send
 * the file straight to blob storage. On a laptop or a VPS there is no such limit and no
 * blob store either, so the file goes through the API as it always has.
 *
 * The server says which of those this deployment is. These tests are about the routing
 * decision, the poster's separate journey, and the size refusal — the three things that
 * are ours rather than the platform's.
 */
import { uploadVideo, uploadConfig, _resetUploadConfig } from "./uploadVideo";

vi.mock("../api", () => ({ http: { get: vi.fn(), post: vi.fn() } }));
vi.mock("./videoPoster", () => ({ captureVideoPoster: vi.fn() }));
vi.mock("@vercel/blob/client", () => ({ upload: vi.fn() }));

import { http } from "../api";
import { captureVideoPoster } from "./videoPoster";
import { upload as blobUpload } from "@vercel/blob/client";

const file = (bytes = 1000, name = "clip.mp4") => ({ size: bytes, name, type: "video/mp4" });
const MB = 1024 * 1024;

const config = (over = {}) =>
  http.get.mockResolvedValue({ data: { max_bytes: 100 * MB, direct_upload: false, ...over } });

beforeEach(() => {
  vi.clearAllMocks();
  _resetUploadConfig();
  captureVideoPoster.mockResolvedValue(new Blob(["x"]));
});

describe("when the deployment has no blob store", () => {
  test("the file and its poster go through the API in one request", async () => {
    config({ direct_upload: false });
    http.post.mockResolvedValue({ data: { url: "/uploads/a.mp4", has_poster: true, thumbnail_url: "/uploads/a.jpg" } });

    const out = await uploadVideo(file());

    expect(blobUpload).not.toHaveBeenCalled();
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ url: "/uploads/a.mp4", poster_url: "/uploads/a.jpg" });
  });

  test("a file the browser could not decode still uploads, without a poster", async () => {
    config({ direct_upload: false });
    captureVideoPoster.mockResolvedValue(null);
    http.post.mockResolvedValue({ data: { url: "/uploads/a.mp4", has_poster: false } });

    expect(await uploadVideo(file())).toEqual({ url: "/uploads/a.mp4", poster_url: "" });
  });
});

describe("when the deployment uploads direct", () => {
  test("the file goes to blob storage, not to the API", async () => {
    config({ direct_upload: true, direct_upload_url: "/api/blob-upload" });
    http.post.mockResolvedValue({ data: { url: "/uploads/poster.jpg" } });
    blobUpload.mockResolvedValue({ url: "https://blob.example.com/clip.mp4" });

    const out = await uploadVideo(file(80 * MB));

    expect(blobUpload).toHaveBeenCalledTimes(1);
    expect(blobUpload.mock.calls[0][2]).toMatchObject({ handleUploadUrl: "/api/blob-upload" });
    expect(out.url).toBe("https://blob.example.com/clip.mp4");
  });

  test("the poster still goes through the API, on its own", async () => {
    // It is one JPEG frame — inside every limit involved, and worth keeping inside the
    // image pipeline that sniffs and re-encodes it.
    config({ direct_upload: true });
    http.post.mockResolvedValue({ data: { url: "/uploads/poster.jpg" } });
    blobUpload.mockResolvedValue({ url: "https://blob.example.com/clip.mp4" });

    const out = await uploadVideo(file(80 * MB));

    expect(http.post).toHaveBeenCalledTimes(1);
    expect(http.post.mock.calls[0][0]).toBe("/admin/uploads");
    expect(out.poster_url).toBe("/uploads/poster.jpg");
  });

  test("the poster is sent before the long upload starts", async () => {
    // So a failure part-way through a 100MB video does not also throw away the frame
    // that was already computed.
    const order = [];
    config({ direct_upload: true });
    http.post.mockImplementation(async () => { order.push("poster"); return { data: { url: "/p.jpg" } }; });
    blobUpload.mockImplementation(async () => { order.push("video"); return { url: "https://b/c.mp4" }; });

    await uploadVideo(file(80 * MB));
    expect(order).toEqual(["poster", "video"]);
  });

  test("progress is reported, which the API route cannot do", async () => {
    config({ direct_upload: true });
    http.post.mockResolvedValue({ data: { url: "/p.jpg" } });
    blobUpload.mockImplementation(async (_n, _f, opts) => {
      opts.onUploadProgress({ percentage: 42.4 });
      return { url: "https://b/c.mp4" };
    });

    const seen = [];
    await uploadVideo(file(80 * MB), { onProgress: (p) => seen.push(p) });
    expect(seen).toEqual([42]);
  });
});

describe("the size ceiling", () => {
  test("an oversized file is refused before anything is sent", async () => {
    config({ max_bytes: 100 * MB, direct_upload: true });

    await expect(uploadVideo(file(120 * MB))).rejects.toThrow(/120MB — the limit is 100MB/);
    expect(blobUpload).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
  });

  test("the ceiling comes from the server, not from a number written here", async () => {
    config({ max_bytes: 25 * MB, direct_upload: false });
    await expect(uploadVideo(file(30 * MB))).rejects.toThrow(/limit is 25MB/);
  });

  test("the refusal is marked as decided here, so the pipeline does not retry it", async () => {
    // Without the marker this error has no response to read a status from, so it falls
    // to `code === 0`: three attempts with backoff, then "Connection lost" shown to the
    // editor. Nothing was lost and nothing would change on a fourth try.
    config({ max_bytes: 25 * MB, direct_upload: false });
    await expect(uploadVideo(file(30 * MB))).rejects.toMatchObject({ refusedLocally: true });
  });
});

describe("when the server cannot answer", () => {
  test("it falls back to the route that has always existed", async () => {
    // A deployment too old to know about /uploads/config is one without direct upload.
    http.get.mockRejectedValue(new Error("404"));
    expect(await uploadConfig()).toMatchObject({ direct_upload: false });
  });

  test("the fallback ceiling is one a request body can actually carry", async () => {
    // Guessing high here is the expensive direction: the editor uploads for a minute
    // and loses the file at the end. Guessing low costs a compress step.
    http.get.mockRejectedValue(new Error("404"));
    const { max_bytes } = await uploadConfig();
    expect(max_bytes).toBeLessThanOrEqual(4.5 * MB);
  });
});
