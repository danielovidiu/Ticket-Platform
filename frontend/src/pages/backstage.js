/**
 * The three staff-only pages, as dynamic imports.
 *
 * Admin, CMSEditor and Scan are a quarter of this app's source — Admin alone is 71 KB,
 * CMSEditor 61 KB — and they were imported statically in App.jsx, so every visitor
 * buying a ticket downloaded the CMS editor before the page could paint. They are the
 * one part of the site with an audience of about three people, which makes them the
 * obvious thing to split out.
 *
 * The loaders live here rather than inline in App.jsx because two callers need them:
 * React.lazy, which turns them into route components, and prefetchBackstage() below,
 * which warms the same chunks for the people who will actually open them. Written
 * inline, the prefetch would have to repeat the import specifiers, and a chunk warmed
 * under one specifier while the route loads another is two downloads, not one.
 *
 * Vite requires the specifier to be a literal — `import("./" + name)` would defeat the
 * static analysis that produces the chunks at all — so they are three named functions.
 */
export const loadAdmin = () => import("./Admin");
export const loadCMSEditor = () => import("./CMSEditor");
export const loadScan = () => import("./Scan");

/** Which chunks are worth warming, per role. Mirrors the `roles` on ACCOUNT_LINKS in
 * Layout.jsx: a door user only ever sees Scan, so only Scan is fetched for them.
 * Anyone else — signed out, or an ordinary ticket holder — gets nothing, which is the
 * whole point of the split. */
const BY_ROLE = {
  admin: [loadAdmin, loadCMSEditor, loadScan],
  editor: [loadCMSEditor],
  door: [loadScan],
};

/**
 * Fetch the chunks this role can reach, while the browser is idle.
 *
 * Splitting a route costs one round trip the first time it is opened, and staff open
 * these pages repeatedly — a door person reloads Scan on a bad connection at the venue.
 * Prefetching moves that request off the critical path: by the time the link is
 * clicked the chunk is in the HTTP cache and React.lazy resolves without a fallback.
 *
 * Failure is not handled because there is nothing to handle. If a prefetch fails the
 * route's own import runs later and either succeeds or shows the error the user would
 * have seen anyway; an unhandled rejection here would only be noise in the console.
 */
export function prefetchBackstage(role) {
  const loaders = BY_ROLE[role];
  if (!loaders) return;
  const warm = () => loaders.forEach((load) => load().catch(() => {}));
  // Idle, so this never competes with the data the page the user is actually looking at
  // is fetching. Safari only shipped requestIdleCallback in 16.4, hence the fallback.
  if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 3000 });
  else setTimeout(warm, 1000);
}
