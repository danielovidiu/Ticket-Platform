/**
 * The CMS-authored eyebrow and name for the four built-in section pages.
 *
 * One request serves all four, and the answer is cached for the life of the tab: these
 * are two short strings per page that change when an editor decides they do, and
 * re-asking on every navigation between Shop and Gallery would be a request per click
 * for an answer that is almost always the same one.
 */
import { useEffect, useState } from "react";
import { http } from "../api";

// The in-flight promise, not the data: two pages mounting in the same tick must share
// one request rather than race two.
let pending = null;
let cached = null;

function load() {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    pending = http.get("/cms/core-pages")
      .then((r) => { cached = r.data || {}; return cached; })
      // A failed fetch is not cached — the next page that asks tries again. It resolves
      // to an empty map rather than rejecting so that a page with no header still
      // renders its content; a backend that is down should cost the wording, not the
      // gallery.
      .catch(() => ({}))
      .finally(() => { pending = null; });
  }
  return pending;
}

/** Test seam: forget what was fetched. */
export function resetCorePageHeaders() {
  cached = null;
  pending = null;
}

/**
 * `null` until the answer arrives, then `{ eyebrow, heading }` — either of which may be
 * an empty string, meaning the editor deleted that line.
 */
export function useCorePageHeader(slug) {
  const [header, setHeader] = useState(() => (cached ? cached[slug] || {} : null));

  useEffect(() => {
    let alive = true;
    load().then((all) => { if (alive) setHeader(all[slug] || {}); });
    return () => { alive = false; };
  }, [slug]);

  return header;
}
