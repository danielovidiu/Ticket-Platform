/** Grab a still frame from a video file, in the browser, as a JPEG Blob.
 *
 * ffmpeg is deliberately not a server dependency, so posters are produced here
 * at upload time and sent alongside the video. Resolves `null` whenever the
 * browser cannot decode the file (some HEVC .mov, exotic codecs) or takes too
 * long — callers then fall back to rendering a live <video> element, so a
 * missing poster never blocks the upload itself.
 */
export function captureVideoPoster(file, { seekTo = 1, maxSize = 640, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let objectUrl;
    try {
      objectUrl = URL.createObjectURL(file);
    } catch {
      resolve(null);
      return;
    }

    const video = document.createElement("video");
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(objectUrl);
      video.removeAttribute("src");
      video.load?.();
      resolve(value);
    };
    // A decode that never fires an event would otherwise hang the whole upload.
    const timer = setTimeout(() => finish(null), timeoutMs);

    const grabFrame = () => {
      try {
        const { videoWidth: w, videoHeight: h } = video;
        if (!w || !h) return finish(null);
        const scale = Math.min(1, maxSize / Math.max(w, h));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => finish(blob), "image/jpeg", 0.82);
      } catch {
        finish(null); // tainted canvas or a decode that failed mid-draw
      }
    };

    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.onerror = () => finish(null);
    video.onloadeddata = () => {
      // The very first frame is usually black, so step in a little — but never
      // past the midpoint, which would overshoot on very short clips.
      const target = Math.min(seekTo, (video.duration || 0) / 2);
      if (target > 0) {
        video.onseeked = grabFrame;
        video.currentTime = target;
      } else {
        grabFrame();
      }
    };
    video.src = objectUrl;
  });
}
