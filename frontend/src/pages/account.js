/**
 * The routes behind a session or a transaction, as dynamic imports.
 *
 * The same argument backstage.js makes, one audience further out. Those three pages are
 * staff-only; these fourteen are for someone who has already decided to buy or has
 * already bought — which is still nobody on the first paint of a marketing site, and the
 * first paint is what every visitor pays for.
 *
 * Concretely: MyTickets draws a ticket's QR code, so it is the only importer of
 * qrcode.react left in the app. Statically imported it put 44.8 kB of QR encoder into the
 * chunk served to a person reading the programme, to render something that only exists
 * after a purchase.
 *
 * WHAT IS DELIBERATELY NOT HERE. Events, EventDetail, Artists, Gallery, Shop and the CMS
 * page renderer stay statically imported in App.jsx, because any of them can be the URL
 * a visitor arrives on — a shared link to one event is the normal way into this site, and
 * splitting it would put a round trip in front of the thing they came for.
 *
 * The auth and newsletter pages ARE split despite being reachable cold from an email
 * link. That trade is one extra round trip on an uncommon cold entry, against every
 * visitor of every page carrying them; prefetchAccount() below then removes it for
 * anyone signed in, who is exactly the population that reaches them again.
 *
 * Specifiers must be literals or Vite cannot see the chunks — see the same note in
 * backstage.js.
 */
export const loadLogin = () => import("./Login");
export const loadCompleteProfile = () => import("./CompleteProfile");
export const loadVerifyEmail = () => import("./VerifyEmail");
export const loadResetPassword = () => import("./ResetPassword");
export const loadSettings = () => import("./Settings");

export const loadCart = () => import("./Cart");
export const loadCheckout = () => import("./Checkout");
export const loadCheckoutSuccess = () => import("./CheckoutSuccess");
export const loadShopCheckout = () => import("./ShopCheckout");
export const loadShopSuccess = () => import("./ShopSuccess");

export const loadMyTickets = () => import("./MyTickets");
export const loadMyOrders = () => import("./MyOrders");

export const loadNewsletterConfirm = () => import("./NewsletterConfirm");
export const loadNewsletterUnsubscribe = () => import("./NewsletterUnsubscribe");

/** What a signed-in person actually reaches from the account menu and the cart, warmed
 * while the browser is idle. Deliberately not the whole list: the auth flows are what
 * someone signed in has just finished, and the newsletter pages arrive from an email
 * rather than from the site. */
const WARM = [loadMyTickets, loadMyOrders, loadSettings, loadCart];

/**
 * Fetch the chunks a signed-in visitor is likely to open next, off the critical path.
 *
 * Mirrors prefetchBackstage(), including its reason for ignoring failures: a prefetch
 * that does not land simply leaves the route's own import to run later.
 */
export function prefetchAccount() {
  const warm = () => WARM.forEach((load) => load().catch(() => {}));
  // Idle, so it never competes with the page the visitor is currently reading.
  // Safari only shipped requestIdleCallback in 16.4, hence the fallback.
  if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 3000 });
  else setTimeout(warm, 1000);
}
