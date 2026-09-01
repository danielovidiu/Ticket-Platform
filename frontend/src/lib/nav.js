import { http } from "../api";

/**
 * The site navigation: how it is loaded, remembered, and re-read when it changes.
 *
 * THE PROBLEM THIS SOLVES. The header used to fetch /cms/nav from Layout's useEffect —
 * after mount, after the first paint — and render a hardcoded list of the built-in
 * sections until it answered. So every page load showed the built-in sections and then
 * the authored pages appeared a request later. The built-ins
 * were not "faster"; they were the placeholder, and everything else was the real answer
 * arriving late.
 *
 * Three things narrow that gap, and they help different visitors:
 *
 *   1. the request starts when this module is imported, not when a component mounts, so
 *      it is already in flight while React is still booting;
 *   2. the last known nav is kept in localStorage and read synchronously, so a returning
 *      visitor gets the REAL menu in the first paint with no request in the way;
 *   3. the response carries an ETag, so the confirming request is usually a 304.
 *
 * A first-time visitor still waits one request. Removing that last gap means putting the
 * nav in the HTML itself, which this deployment cannot do without a rendering step.
 */

const EVENT = "cms:nav-changed";

// Versioned: the shape below is what the header reads, and a stale shape from an older
// bundle would render a broken menu rather than no menu.
const CACHE_KEY = "cms:nav:v1";

/** Shape check rather than trust. This came out of storage, which anything on the origin
 * can write, and it is rendered straight into the header as links. */
const looksLikeNav = (items) =>
  Array.isArray(items) &&
  items.every(
    (n) =>
      n &&
      typeof n.label === "string" &&
      typeof n.route === "string" &&
      // A leading "/" is not enough: "//evil.example/x" starts with one and is a
      // protocol-relative URL to another origin, so it would render as an in-app link
      // that leaves the site.
      n.route.startsWith("/") &&
      !n.route.startsWith("//"),
  );

/** The last nav this browser saw, or [] — safe to call during render. */
export function readCachedNav() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    return looksLikeNav(parsed) ? parsed : [];
  } catch {
    // Private mode, disabled storage, or corrupt JSON. The fallback nav covers it.
    return [];
  }
}

function writeCachedNav(items) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(items));
  } catch {
    // Storage full or unavailable; the nav still works, it just won't be instant next time.
  }
}

// One request per page load, shared by every caller. The resolved promise is kept rather
// than cleared, so the eager fetch below and Layout's own call are the same request.
let navPromise = null;

/** Fetch the nav, reusing the in-flight or completed request unless forced. */
export function loadNav({ force = false } = {}) {
  if (force || !navPromise) {
    navPromise = http.get("/cms/nav").then(({ data }) => {
      if (!looksLikeNav(data)) throw new Error("unexpected nav shape");
      writeCachedNav(data);
      return data;
    });
    // A failure must not be remembered as the answer, or the header stays on the
    // fallback for the life of the tab.
    navPromise.catch(() => { navPromise = null; });
  }
  return navPromise;
}

// Started at import, on purpose. This module is pulled in by Layout, which is on every
// page, so by the time React renders the header the answer is often already here.
loadNav().catch(() => {});

/** Call after any CMS write that can change what the nav bar shows. */
export const navChanged = () => window.dispatchEvent(new Event(EVENT));

/** Subscribe. Returns the unsubscribe function, so it can be returned from useEffect. */
export const onNavChanged = (handler) => {
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
};
