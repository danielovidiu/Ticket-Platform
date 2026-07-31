/**
 * Signal that the site navigation changed, so the header can reload it.
 *
 * The header reads /cms/nav once, when Layout mounts. Layout wraps every route —
 * including the CMS editor itself — so it never remounts during client-side navigation.
 * That meant reordering pages updated the database and the CMS sidebar while the header
 * went on showing the arrangement it fetched when the tab was opened, and the change
 * only appeared after a full reload. From the editor it looked like the reorder had
 * simply not worked.
 *
 * A window event rather than a context or a store: the two components are far apart in
 * the tree, only one of them cares, and nothing needs to be rendered from the signal.
 */
const EVENT = "cms:nav-changed";

/** Call after any CMS write that can change what the nav bar shows. */
export const navChanged = () => window.dispatchEvent(new Event(EVENT));

/** Subscribe. Returns the unsubscribe function, so it can be returned from useEffect. */
export const onNavChanged = (handler) => {
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
};
