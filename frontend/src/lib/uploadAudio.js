import { upload as blobUpload } from "@vercel/blob/client";
import { http } from "../api";
import { uploadConfig } from "./uploadVideo";

/**
 * Getting an audio clip into the CMS, by whichever route this deployment has.
 *
 * The same two routes video takes, and `uploadConfig` is deliberately imported from there
 * rather than re-derived: which route exists is a property of the DEPLOYMENT, not of the
 * kind of file being sent, and two copies of that question would eventually give two
 * answers.
 *
 * What audio does not have is a poster. A video needs a frame captured in the browser
 * because there is no ffmpeg on the server to pull one; a sound file has no frame to
 * pull, so this is the video path with that half deleted.
 *
 * A 90-second clip is around 1.5MB at a normal bitrate, so it fits the small serverless
 * ceiling and usually goes straight through the API. The direct route is still honoured
 * for the case that does not fit — an uncompressed WAV, which is 10MB a minute.
 */
/**
 * The formats both ends accept: `AUDIO_CONTENT_TYPES` in backend/server.py, and the
 * allowlist the direct-upload token is minted against in blob-upload/index.js.
 *
 * Checked HERE as well as there because of how a refusal on the direct route arrives. The
 * token request is refused before any bytes move, and the client sees an error carrying no
 * HTTP response — which the pipeline reads as a dropped connection, retries three times,
 * and finally reports as "Connection lost". True of nothing that happened, and it points
 * whoever reads it at their network instead of at their file. A type this list does not
 * hold is refused up front instead, by name, with nothing sent.
 */
const ACCEPTED = new Set([
  "audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg", "audio/mp4", "audio/x-m4a",
  "audio/aac",
]);

export async function uploadAudio(file, { onProgress } = {}) {
  const config = await uploadConfig();

  if (file.type && !ACCEPTED.has(file.type)) {
    const error = new Error(
      `${file.type || "That file"} is not a format the player can use — export it as MP3, WAV, OGG or M4A.`);
    // Same marker the size refusal uses: decided here, nothing sent, and retrying it
    // would only arrive at the same answer more slowly.
    error.refusedLocally = true;
    throw error;
  }

  if (file.size > config.max_bytes) {
    const mb = Math.round(config.max_bytes / (1024 * 1024));
    const error = new Error(
      `That clip is ${Math.round(file.size / (1024 * 1024))}MB — the limit is ${mb}MB. Export it as an MP3 and try again.`);
    // Decided here, with nothing sent: the pipeline reads this to stop rather than retry
    // its way to the same answer.
    error.refusedLocally = true;
    throw error;
  }

  if (!config.direct_upload) {
    const fd = new FormData();
    fd.append("file", file);
    const { data } = await http.post("/admin/uploads", fd);
    return { url: data.url };
  }

  const blob = await blobUpload(file.name, file, {
    access: "public",
    handleUploadUrl: config.direct_upload_url || "/api/blob-upload",
    contentType: file.type,
    onUploadProgress: onProgress ? (e) => onProgress(Math.round(e.percentage)) : undefined,
  });

  return { url: blob.url };
}
