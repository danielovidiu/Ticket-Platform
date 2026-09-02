import { upload as blobUpload } from "@vercel/blob/client";
import { http } from "../api";
import { captureVideoPoster } from "./videoPoster";

/**
 * Getting a video file into the CMS, by whichever route this deployment actually has.
 *
 * There are two, and the difference is not a preference:
 *
 *   THROUGH THE API — the normal path, and the only one that exists on a laptop or a VPS.
 *   The file is sniffed and the poster travels with it in one request.
 *
 *   STRAIGHT TO BLOB — the browser sends the file to storage itself, having asked
 *   /api/blob-upload for a short-lived token. Necessary on Vercel, which refuses a
 *   request body over about 4.5MB before the API is reached at all, and so cannot carry
 *   a video of any real length. Measured: 4MB reaches the app, 5MB is refused by the edge.
 *
 * The server says which one it has (`/uploads/config`), rather than this guessing from
 * the hostname or finding out by watching an upload fail.
 *
 * The POSTER goes through the API either way. It is a single JPEG frame, comfortably
 * inside every limit involved, and sending it the normal way means it is still sniffed
 * and re-encoded like any other image.
 */

let configPromise = null;

/** Cached for the session: it cannot change under a running editor. */
export function uploadConfig() {
  if (!configPromise) {
    configPromise = http.get("/uploads/config")
      .then((r) => r.data)
      // A deployment too old to answer is one without direct upload, which is the safe
      // reading — it means "use the path that has always existed".
      .catch(() => ({ max_bytes: 25 * 1024 * 1024, direct_upload: false }));
  }
  return configPromise;
}

/** For tests, which must not inherit a cached answer from a previous case. */
export function _resetUploadConfig() {
  configPromise = null;
}

/** The poster frame, uploaded on its own. Returns "" when the browser could not decode
 *  one — the video still uploads, the block just opens on a black frame. */
async function sendPoster(file) {
  const poster = await captureVideoPoster(file);
  if (!poster) return "";
  const fd = new FormData();
  fd.append("file", poster, "poster.jpg");
  const { data } = await http.post("/admin/uploads", fd);
  return data.url || "";
}

/**
 * Upload `file`, returning `{ url, poster_url }`.
 *
 * `onProgress` is called with 0..100 where the route can report it. The direct path can;
 * the API path cannot, so it reports nothing rather than inventing a number.
 */
export async function uploadVideo(file, { onProgress } = {}) {
  const config = await uploadConfig();

  if (file.size > config.max_bytes) {
    const mb = Math.round(config.max_bytes / (1024 * 1024));
    throw new Error(`That video is ${Math.round(file.size / (1024 * 1024))}MB — the limit is ${mb}MB. Compress it and try again.`);
  }

  if (!config.direct_upload) {
    // One request carries both, exactly as it always has.
    const fd = new FormData();
    fd.append("file", file);
    const poster = await captureVideoPoster(file);
    if (poster) fd.append("poster", poster, "poster.jpg");
    const { data } = await http.post("/admin/uploads", fd);
    return { url: data.url, poster_url: data.has_poster ? data.thumbnail_url : "" };
  }

  // The poster first and separately: it is small, it goes the ordinary way, and having it
  // before the long upload means a failure half way through the video does not also lose
  // the frame that was already computed.
  const poster_url = await sendPoster(file);

  const blob = await blobUpload(file.name, file, {
    access: "public",
    handleUploadUrl: config.direct_upload_url || "/api/blob-upload",
    contentType: file.type,
    onUploadProgress: onProgress ? (e) => onProgress(Math.round(e.percentage)) : undefined,
  });

  return { url: blob.url, poster_url };
}
