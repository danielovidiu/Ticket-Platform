import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useAuth, startLogin } from "../auth";
import { http } from "../api";
import { SOCIAL_PLATFORMS } from "../lib/social";
import { Menu, X, ShoppingBag, ChevronDown, User } from "lucide-react";
import { useCart } from "../lib/cart";
import { loadNav, onNavChanged, readCachedNav } from "../lib/nav";
import { prefetchBackstage } from "../pages/backstage";

/** Nav of last resort: shown only if /cms/nav cannot be reached at all.
 *
 * This used to be the FIRST thing rendered on every page load, with the CMS list
 * replacing it on arrival. That is what made the menu look like it loaded in two stages —
 * these five appeared immediately and the authored pages arrived a request later. They
 * were never faster; they were the placeholder.
 *
 * The built-in sections are CMS rows themselves (`kind: "core"` — see CORE_NAV_ITEMS in
 * cms_routes.py), editable for label, order and visibility like any other page. So the
 * server's list is the ONLY correct answer, and rendering a hardcoded guess before it
 * arrives can only ever be wrong-then-corrected.
 *
 * It survives as a fallback because a site whose nav request fails should still be
 * navigable — but it is a failure path now, not the opening state.
 */
const OFFLINE_NAV = [
  { route: "/events", label: "Events" },
  { route: "/shop", label: "Shop" },
  { route: "/artists", label: "Artists" },
  { route: "/gallery", label: "Gallery" },
];

/** Everything reachable from the account menu, with the role that may see it.
 * One list so the desktop dropdown and the mobile sheet cannot drift apart. */
const ACCOUNT_LINKS = [
  { to: "/my-tickets", label: "My Tickets", testid: "my-tickets-link" },
  { to: "/my-orders", label: "My Orders", testid: "my-orders-link" },
  { to: "/settings", label: "Profile", testid: "settings-link" },
  { to: "/admin", label: "Admin", testid: "admin-link", roles: ["admin"] },
  { to: "/cms", label: "CMS", testid: "cms-link", roles: ["admin", "editor"] },
  { to: "/scan", label: "Scan", testid: "scan-link", roles: ["admin", "door"] },
];

const linksFor = (user) =>
  ACCOUNT_LINKS.filter((l) => !l.roles || l.roles.includes(user?.role));

/** Cart entry point. Always visible so the shop reads as a shop, but the count only
 * exists once signed in — carts live on the account, not in this browser. */
const CartLink = ({ onNavigate }) => {
  const { cart } = useCart();
  const count = cart?.count || 0;
  return (
    <Link to="/cart" onClick={onNavigate} data-testid="cart-link"
          className="btn-primary !py-2 !px-3 !text-[10px] relative inline-flex items-center gap-2">
      <ShoppingBag size={13} />
      <span>Cart</span>
      {count > 0 && (
        <span data-testid="cart-count"
              className="bg-brand text-page px-1.5 min-w-[18px] text-center font-mono-x text-[10px] leading-[16px]">
          {count}
        </span>
      )}
    </Link>
  );
};

/** Signed-in account menu, and the sign-in button that stands in its place.
 *
 * Both states render exactly one control of the same size. That is the point: the header
 * used to swap a single "Sign In" button for up to seven action buttons, which re-wrapped
 * the flex row and pushed the whole bar taller the moment you logged in. Collapsing them
 * into a dropdown keeps the layout identical either way.
 */
const AccountMenu = ({ user, logout }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const location = useLocation();

  // Close on outside click and on Escape — a menu that survives a click elsewhere reads
  // as stuck, and one that survives navigation hangs over the page it just left.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  useEffect(() => { setOpen(false); }, [location.pathname]);

  if (!user) {
    return (
      <button onClick={() => startLogin("/my-tickets")} data-testid="login-btn" className="btn-accent">
        Sign In
      </button>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((v) => !v)} data-testid="account-menu-toggle"
              aria-haspopup="menu" aria-expanded={open}
              className="btn-accent inline-flex items-center gap-2">
        <User size={13} />
        {/* "Account" is the menu, "Profile" is the settings page nested inside it —
            they are deliberately different words so the label is not repeated twice. */}
        <span>Account</span>
        <ChevronDown size={13} className={open ? "rotate-180 transition-transform" : "transition-transform"} />
      </button>
      {open && (
        <div role="menu" data-testid="account-menu"
             className="absolute right-0 top-full mt-2 min-w-[180px] border border-ink/15 bg-page py-1 z-50">
          <div className="px-3 py-2 font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 truncate">
            {user.email}
          </div>
          {linksFor(user).map((l) => (
            <Link key={l.to} to={l.to} role="menuitem" data-testid={l.testid}
                  className="block px-3 py-2 text-[11px] uppercase tracking-[0.18em] font-mono-x text-ink-2 hover:text-ink hover:bg-ink/10">
              {l.label}
            </Link>
          ))}
          <button onClick={logout} role="menuitem" data-testid="logout-btn"
                  className="block w-full text-left px-3 py-2 text-[11px] uppercase tracking-[0.18em] font-mono-x text-ink-2 hover:text-ink hover:bg-ink/10">
            Logout
          </button>
        </div>
      )}
    </div>
  );
};

const Header = ({ cmsNav, navFailed, site }) => {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  // Warm the chunks behind the staff links this role can see. Admin, CMS and Scan are
  // split out of the main bundle (see pages/backstage.js), which costs one round trip
  // the first time one is opened — paid here, while the browser is idle, instead of
  // after the click. Keyed on the role rather than on `user` so it does not re-run when
  // an unrelated field of the account object changes; the loaders are idempotent anyway,
  // since a module already imported resolves from the module registry.
  useEffect(() => { prefetchBackstage(user?.role); }, [user?.role]);
  // Order, labels and hrefs all come from the CMS — see cms_routes.get_public_nav.
  //
  // Empty until the answer is known, rather than showing the built-ins and adding the
  // rest a moment later: the whole menu appears at once, in one arrangement, or not yet.
  // Safe to render nothing here because the row is `justify-between` with both outer
  // groups `shrink-0` — the logo and the account controls are pinned to the edges, and
  // the nav sits in the space between them, so an empty nav moves nothing and the row's
  // height comes from the logo either way.
  const nav = cmsNav.length ? cmsNav : navFailed ? OFFLINE_NAV : [];
  return (
    <header className="sticky top-0 z-40 bg-page hairline-b">
      {/* The nav appears from `md` (768px), not `lg`. At `lg` a tablet held either way up
          got the phone treatment — a hamburger hiding seven links that had room to sit
          in the bar, on a device with a pointer and no reason to tap twice for the menu.
          The bar already scrolls horizontally rather than wrapping, so a long nav degrades
          by scrolling instead of by disappearing.

          It takes a SECOND ROW to do that between md and lg. Seven links, the wordmark
          and two buttons need about 880px in one line, and a tablet has 768 — so the
          first attempt at this left the nav scrolling inside 271px with four links
          (Gallery, Events, Shop, Contact) off the end, behind a scrollbar that is
          deliberately invisible. That is fewer reachable links than the hamburger it
          replaced, which is the opposite of the point. The nav takes the full width on
          its own line instead, and rejoins the row at lg where it fits.

          One row above lg. The account actions live behind a dropdown now, so the
          right-hand group is two controls at every role and in both auth states — the
          header can no longer change height or re-wrap when somebody signs in. The nav
          itself still grows with each CMS page, so it scrolls horizontally rather than
          pushing the row open. */}
      <div className="max-w-[1400px] mx-auto edge-inset py-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <Link to="/" data-testid="logo-link" className="font-display text-xl md:text-2xl font-bold tracking-tighter uppercase shrink-0">
          {site?.header_wordmark ?? "SUPERSANITY"}
        </Link>
        {/* Size comes from the theme (--nav-size), not a fixed class: how big the menu
            should be depends on how many items it holds and how long their labels are,
            both of which an editor changes. 11px is the value it shipped with, so a
            theme saved before this existed renders exactly as it did. */}
        <nav className="hidden md:flex order-last lg:order-none w-full lg:w-auto items-center gap-x-5 min-w-0 overflow-x-auto no-scrollbar font-mono-x uppercase tracking-[0.18em] text-[length:var(--nav-size,11px)]">
          {nav.map((n) => (
            <NavLink key={n.route} to={n.route} end={n.route === "/"} data-testid={`nav-${n.label.toLowerCase()}`}
              className={({ isActive }) => `whitespace-nowrap ${isActive ? "text-ink" : "text-ink-3 hover:text-ink transition-colors"}`}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="hidden md:flex items-center gap-2 shrink-0">
          <CartLink />
          <AccountMenu user={user} logout={logout} />
        </div>
        <button className="md:hidden" data-testid="menu-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? <X /> : <Menu />}
        </button>
      </div>
      {open && (
        <div className="md:hidden hairline-b bg-page">
          <div className="edge-inset py-6 flex flex-col gap-4 font-mono-x uppercase text-[length:max(var(--nav-size,11px),0.875rem)]">
            {nav.map((n) => <NavLink key={n.route} to={n.route} onClick={() => setOpen(false)} className="text-ink-2">{n.label}</NavLink>)}
            <CartLink onNavigate={() => setOpen(false)} />
            {user ? (
              <>
                {/* Same ACCOUNT_LINKS as the desktop dropdown — a sheet is already a
                    vertical list, so it shows them inline rather than nesting a menu. */}
                {linksFor(user).map((l) => (
                  <Link key={l.to} to={l.to} onClick={() => setOpen(false)}>{l.label}</Link>
                ))}
                <button onClick={logout} className="text-left">Logout</button>
              </>
            ) : (
              <button onClick={() => startLogin("/my-tickets")} className="btn-accent w-fit">Sign In</button>
            )}
          </div>
        </div>
      )}
    </header>
  );
};

/**
 * The footer's words come from the CMS; its links are CMS pages.
 *
 * All of this used to be typed in here — a wordmark, a sentence, three hrefs, an address
 * and a copyright line. The links were the worst of it: they pointed AT CMS pages by
 * hardcoded path, so renaming or unpublishing one left the footer aimed at a 404 with
 * nothing to say so. Pages are chosen with `in_footer` now, and a page in the footer is
 * kept out of the top nav — the footer is where the pages that are not part of the
 * journey go.
 *
 * `site` is null until the first response. The footer renders its frame either way
 * rather than collapsing, because it sits at the bottom of every page and a layout that
 * changes height after load pushes whatever the reader was looking at.
 */
// No margin above it. `mt-24` put 96px between the last block and the footer — the same
// kind of gap the flush-blocks pass removed from between every other pair of blocks:
// spacing decided by a component rather than by the person composing the page. The page
// ends where its last block ends, and the hairline is the join.
//
// Its own padding is `py-5` — the header's value, so the two bars sit at the same
// weight. It was py-14, which made the footer more than twice the header's height for
// the same reason nothing else on the page had a say in its own spacing.
const Footer = ({ site }) => {
  const s = site || {};
  const pages = s.pages || [];
  const social = Object.entries(s.social || {}).filter(([, v]) => v);
  // Ordered by the shared vocabulary, not by the key order of the stored object — the
  // same rule the artist page follows.
  const socialLinks = SOCIAL_PLATFORMS
    .map((p) => social.find(([k]) => k === p.key) && [p.key, s.social[p.key], p.label])
    .filter(Boolean);

  return (
    <footer className="hairline">
      {/* As many columns as fit, never narrower than 150px, capped at four.

          This is about HEIGHT. Stacked in a single column the four blocks paid three 40px
          gaps: measured at 375px, 120px of the footer's 445 was empty space, more than a
          quarter of it. Two to a row costs one gap instead of three and takes the footer
          to 285.

          `auto-fit` applies only BELOW sm. Above it the old fixed counts are kept, and
          that is a correction: auto-fit alone gave three columns at 768px where the rule
          used to give two, which put the four blocks in a 3+1 arrangement and made the
          footer 4px TALLER than before — measured at 241 against 245. The saving was only
          ever meant to come from phones, so above sm nothing moves.

          `auto-fit` with a floor rather than `grid-cols-2`, because on a phone the width
          available is not the real constraint — the WORDMARK is. "Supersanity" measures 157px and
          is a single word, so it cannot wrap; at 375px two columns leave it 159.5px, a
          margin of 2.5px. This is a whitelabel product and the next customer's name is
          not this one's, so a hard `grid-cols-2` would be a layout that happens to fit
          one string. The floor lets the browser decide: two columns at 375, one at 320,
          four at 1400, and never a column too narrow for its contents.

          The gap is tighter on a phone for the same reason it was too big: 40px between
          columns is proportionate at 1400px wide and is a third of the screen at 375.
          Desktop keeps it. */}
      <div className="max-w-[1400px] mx-auto edge-inset py-5 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-6 md:gap-10">
        <div>
          {/* Smaller where the columns are narrow, and `break-words` as the last resort:
              a brand name that wraps is survivable, one sliced off at the column edge is
              not. Neither is reached with the current wordmark — both are here because
              the next deployment's is a different length. */}
          <div className="font-display text-xl sm:text-2xl uppercase tracking-tighter break-words">{s.wordmark || ""}</div>
          {s.description && <p className="mt-4 text-ink-3 text-sm max-w-xs">{s.description}</p>}
          {socialLinks.length > 0 && (
            <div className="mt-5 flex flex-wrap gap-x-4 gap-y-2" data-testid="footer-social">
              {socialLinks.map(([key, href, label]) => (
                <a key={key} href={href} target="_blank" rel="noreferrer"
                   className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-3 hover:text-ink">
                  {label}
                </a>
              ))}
            </div>
          )}
        </div>
        {pages.length > 0 && (
          <div data-testid="footer-legal">
            <div className="font-mono-x text-xs uppercase tracking-[0.2em] text-ink-4 mb-4">{s.legal_heading}</div>
            <ul className="space-y-2 text-sm text-ink-2">
              {pages.map((p) => (
                <li key={p.slug}><Link to={`/${p.slug}`} className="hover:text-ink">{p.label}</Link></li>
              ))}
            </ul>
          </div>
        )}
        {s.contact_email && (
          <div>
            <div className="font-mono-x text-xs uppercase tracking-[0.2em] text-ink-4 mb-4">{s.contact_heading}</div>
            {/* An address has no spaces to break at, so it needs an explicit rule
                to wrap instead of running past its column. */}
            <p className="text-ink-2 text-sm break-words">{s.contact_email}</p>
          </div>
        )}
        {/* The YEAR stays computed. A hardcoded year is a bug that surfaces once, in
            January, on every page at the same time. */}
        <div className="font-mono-x text-xs text-ink-4">© {new Date().getFullYear()} {s.copyright_name || ""}</div>
      </div>
    </footer>
  );
};

export default function Layout({ children }) {
  // Seeded from the last nav this browser saw, read synchronously so a returning visitor
  // renders the real menu in the FIRST paint. Without it the header shows the built-in
  // sections and the authored pages appear a request later, which reads as the site
  // loading in two stages.
  const [cmsNav, setCmsNav] = useState(readCachedNav);
  // The site's own words: both wordmarks and everything the footer says. One request for
  // the whole layout rather than one per component that needs a word out of it.
  const [site, setSite] = useState(null);
  useEffect(() => {
    http.get("/cms/site").then((r) => setSite(r.data)).catch(() => {});
  }, []);
  // Only true once a request has actually failed, which is what lets the header tell
  // "not yet" apart from "not coming" — and show the offline nav for the second only.
  const [navFailed, setNavFailed] = useState(false);
  const refreshNav = useCallback((force) => {
    loadNav({ force })
      .then((items) => { setCmsNav(items); setNavFailed(false); })
      .catch(() => setNavFailed(true));
  }, []);
  // Confirm on mount (usually a 304 against the request this module already started),
  // then again whenever the CMS says the nav changed. Layout never unmounts during
  // client-side navigation, so without the subscription an editor who reorders pages and
  // returns to the site keeps seeing the order from when the tab was opened.
  useEffect(() => {
    refreshNav(false);
    return onNavChanged(() => refreshNav(true));
  }, [refreshNav]);
  // The header and footer are common to every page — including full-screen tools
  // like Scan and the CMS editor.
  return (
    <div className="min-h-screen flex flex-col">
      <div className="grain-overlay" />
      <Header cmsNav={cmsNav} navFailed={navFailed} site={site} />
      <main className="flex-1 min-h-0">{children}</main>
      <Footer site={site} />
    </div>
  );
}
