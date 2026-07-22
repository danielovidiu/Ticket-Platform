const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "";

/** Uploaded media is stored as root-relative paths (e.g. `/uploads/x.jpg`);
 * seed/legacy items are absolute URLs (Unsplash etc.) — pass those through. */
export function mediaUrl(path) {
  if (!path) return path;
  if (/^https?:\/\//.test(path)) return path;
  return `${BACKEND_URL}${path}`;
}
