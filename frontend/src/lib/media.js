const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "";

/**
 * The hosts a deployed page can actually LOAD an image from.
 *
 * Not a security control — the browser's `img-src` is, and it holds whatever this file
 * says. This list exists so an editor is told before saving, instead of pasting a URL,
 * seeing an empty box on the live page, and having no way to find out why.
 *
 * It mirrors `img-src` in vercel.json (and the nginx block in DEPLOY_VPS.md), the same
 * way EMBED_HOSTS mirrors `frame-src` — and, like that one, the two are kept honest by a
 * test rather than by hoping: backend/tests/test_media_allowlist.py fails if they drift.
 * Drift is silent and only ever surfaces in production.
 *
 * A leading dot means "this host or any subdomain of it".
 */
export const MEDIA_HOSTS = [
  "images.unsplash.com",
  ".blob.vercel-storage.com",
];

/**
 * Why this URL will not display, or null when it will.
 *
 * Deliberately returns a REASON rather than a boolean. "That will not load" is what the
 * editor already gets from a broken <img>, and it is the unhelpful half of the answer;
 * which rule refused it, and what would satisfy that rule, is the half worth having.
 */
export function mediaUrlProblem(url) {
  const value = (url || "").trim();
  if (!value) return null;

  // A relative path is served from this origin, which `img-src 'self'` always allows.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith("//")) return null;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return "That is not a URL. Paste a full https:// address, or upload a file.";
  }

  if (parsed.protocol === "http:") {
    // Blocked twice over: the CSP names no http: source, and a browser refuses mixed
    // content on an https page regardless. Worth its own message because the fix is
    // usually one character.
    return "Use https:// — an http:// image is blocked on a secure page.";
  }
  if (parsed.protocol !== "https:") {
    return `${parsed.protocol} images are not allowed. Paste an https:// URL, or upload a file.`;
  }

  const host = parsed.hostname.toLowerCase();
  const allowed = MEDIA_HOSTS.some((h) => (h.startsWith(".")
    ? host.endsWith(h) || host === h.slice(1)
    : host === h));
  if (!allowed) {
    return `Images cannot be loaded from ${host}. Upload the file instead — it is then `
      + "served from this site's own storage.";
  }
  return null;
}

/** Uploaded media is stored as root-relative paths (e.g. `/uploads/x.jpg`);
 * seed/legacy items are absolute URLs (Unsplash etc.) — pass those through. */
export function mediaUrl(path) {
  if (!path) return path;
  if (/^https?:\/\//.test(path)) return path;
  return `${BACKEND_URL}${path}`;
}
