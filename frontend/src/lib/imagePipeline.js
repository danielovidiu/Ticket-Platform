/**
 * Prepare an image for upload, on this machine, before a byte goes over the wire.
 *
 * WHY THIS EXISTS. Uploads are posted to a serverless function, and the platform
 * refuses a request body over ~4.5 MB before the app ever sees it — so the app's own
 * 25 MB cap never gets a say, and the editor gets a bare failure with no message worth
 * reading. A photo off a current phone is routinely 3–12 MB, which is why dropping 20 of
 * them fails on *some* of them: whichever ones happen to be large. That looks patternless
 * from the outside, because the pattern is a file size nobody sees.
 *
 * Downscaling here removes the cause rather than papering over it, and costs nothing
 * worth keeping: 2560px on the long edge is larger than any slot on this site renders,
 * and the server re-encodes and strips metadata from whatever it receives anyway.
 *
 * Everything degrades to "send the original": a file this cannot decode is still handed
 * to the server exactly as it was, which is the behaviour that existed before.
 */

/** Long edge of the stored image. Above what any layout here renders, well below
 * anything that troubles a request body. */
export const MAX_EDGE = 2560;
export const QUALITY = 0.82;

/** Files at or under this are sent untouched — they already upload fine, and re-encoding
 * them would spend quality to solve a problem they don't have. */
export const PROCESS_ABOVE_BYTES = 3.5 * 1024 * 1024;

/** What the server will accept as a declared type. Anything else this produces is
 * discarded in favour of the original file. */
const UPLOADABLE = new Set(["image/jpeg", "image/png", "image/webp"]);

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** GIF is deliberately excluded: a canvas holds one frame, so re-encoding an animation
 * would silently flatten it to a still. */
export function isProcessableImage(file) {
  return !!file && file.type.startsWith("image/") && file.type !== "image/gif";
}

export function needsProcessing(file, threshold = PROCESS_ABOVE_BYTES) {
  return isProcessableImage(file) && file.size > threshold;
}

/** The type to encode as. PNG becomes WebP because a photo re-encoded as PNG is often
 * larger than the original, and WebP keeps the alpha channel that JPEG would fill in
 * with black. Formats the server doesn't take (HEIC off an iPhone, say) aim for JPEG —
 * a browser that can decode one then makes it uploadable, and one that can't falls
 * back to the original and the server's own error. */
function targetType(file) {
  if (file.type === "image/jpeg" || file.type === "image/webp") return file.type;
  if (file.type === "image/png") return "image/webp";
  return "image/jpeg";
}

async function decode(file) {
  // `from-image` applies the EXIF rotation a phone writes, instead of baking a sideways
  // photo into the pixels. Browsers that reject the option get a plain decode rather
  // than losing the file over it.
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    /* fall through */
  }
  try {
    return await createImageBitmap(file);
  } catch {
    return null;
  }
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } catch {
      resolve(null);
    }
  });
}

function renamed(name, type) {
  const ext = EXT[type];
  if (!ext) return name;
  const stem = name.replace(/\.[^.]+$/, "") || "image";
  return `${stem}.${ext}`;
}

/**
 * Returns a smaller File, or the original when there is nothing to gain and whenever
 * anything at all goes wrong. Never throws: a failure here must not cost the upload.
 */
export async function processImage(file, { maxEdge = MAX_EDGE, quality = QUALITY } = {}) {
  if (!isProcessableImage(file)) return file;

  const bitmap = await decode(file);
  if (!bitmap) return file;

  try {
    const { width: w, height: h } = bitmap;
    if (!w || !h) return file;

    const scale = Math.min(1, maxEdge / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));

    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const wanted = targetType(file);
    const blob = await toBlob(canvas, wanted, quality);
    // Safari has historically answered a type it doesn't encode with a PNG instead of
    // null, so trust what came back rather than what was asked for.
    if (!blob || !UPLOADABLE.has(blob.type)) return file;

    // Re-encoding a small or already-efficient image can make it bigger. If it did,
    // the original is simply the better file.
    if (blob.size >= file.size) return file;

    return new File([blob], renamed(file.name, blob.type), {
      type: blob.type,
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    bitmap.close?.();
  }
}
