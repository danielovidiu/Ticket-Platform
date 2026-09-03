import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useAuth, startLogin } from "../auth";
import { http } from "../api";
import { SOCIAL_PLATFORMS, socialIconPath } from "../lib/social";
import { useFooterReveal } from "../lib/footerReveal";
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
      <div className="max-w-[1400px] mx-auto edge-inset py-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
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
  const reveal = useFooterReveal();
  const pages = s.pages || [];
  const social = Object.entries(s.social || {}).filter(([, v]) => v);
  // Ordered by the shared vocabulary, not by the key order of the stored object — the
  // same rule the artist page follows.
  const socialLinks = SOCIAL_PLATFORMS
    .map((p) => social.find(([k]) => k === p.key) && [p.key, s.social[p.key], p.label])
    .filter(Boolean);

  return (
    /* One line: the year on the left, the marks in the middle, the pages on the right.
     *
     * It was two rows and a rule, and before that four headed columns. Each rework took
     * out what the shape did not need, and this one takes out the shape: a footer whose
     * whole content is a copyright, some icons and three links does not need to be
     * divided into parts.
     *
     * No `hairline`. The border-top that separated the footer from the page went with the
     * rule that separated its two rows — with one line left there is nothing to divide,
     * and the line reads as the end of the page without being told where the page ends.
     *
     * The wordmark, the description and the contact address are gone from here and their
     * controls are gone from the CMS. A field an editor can change that changes nothing
     * on the site is the same bug as a save that silently does not save.
     */
    <footer
      /* Out of the document's flow, so the page runs to the bottom of the window and a
         background photo or a video reaches the edge of the screen instead of stopping
         above a bar. Nothing below it is reserved: the content bleeds under, which is the
         point.

         `opacity` is the whole effect and it is inline because it is a number per frame,
         not a class. Two things ride along with it:

         `visibility` — at zero the footer is not merely invisible, it is out of the tab
         order and out of the accessibility tree. Otherwise the first Tab on any page
         lands on a link nobody can see. The links stay reachable the only way a footer
         ever is: by going to the bottom of the page.

         `pointerEvents` — an invisible element that still swallows clicks would take
         them from whatever is drawn underneath it, across the full width of the window,
         on every page. */
      style={{
        opacity: reveal,
        visibility: reveal === 0 ? "hidden" : "visible",
        pointerEvents: reveal === 0 ? "none" : "auto",
      }}
      className="fixed bottom-0 inset-x-0 z-30"
      data-testid="site-footer">
      {/* Explicit column placement, not auto-flow. With `sm:col-start-*` each group holds
          its own track whether or not the others render: no social links filled, and the
          pages still sit on the right rather than sliding into the middle. Auto-placement
          fills tracks in source order and would do exactly that.

          Below sm the tracks collapse and the three groups wrap in a centred stack, which
          is the only thing that fits 375px. */}
      <div className="max-w-[1400px] mx-auto edge-inset py-3
                      flex flex-wrap items-center justify-center gap-x-8 gap-y-2
                      sm:grid sm:grid-cols-[1fr_auto_1fr]">

        <div className="font-mono-x text-xs text-ink-4 sm:col-start-1 sm:justify-self-start">
          {/* The YEAR stays computed. A hardcoded year is a bug that surfaces once, in
              January, on every page at the same time. */}
          © {new Date().getFullYear()} {s.copyright_name || ""}
        </div>

        {socialLinks.length > 0 && (
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 sm:col-start-2 sm:justify-self-center"
               data-testid="footer-social">
            {socialLinks.map(([key, href, label]) => {
              const path = socialIconPath(key);
              return (
                <a key={key} href={href} target="_blank" rel="noreferrer"
                   aria-label={label} title={label}
                   className="text-ink-3 hover:text-ink transition-colors"
                   data-testid={`footer-social-${key}`}>
                  {path ? (
                    /* `currentColor` so the mark inherits the link's hover, and
                       aria-hidden because the accessible name is on the anchor — a title
                       inside the svg as well would read the platform twice. */
                    <svg viewBox="0 0 24 24" className="w-4 h-4 block" fill="currentColor" aria-hidden="true">
                      <path d={path} />
                    </svg>
                  ) : (
                    /* `website` has no brand mark, because it is not a brand. */
                    <span className="font-mono-x text-[10px] uppercase tracking-[0.2em]">{label}</span>
                  )}
                </a>
              );
            })}
          </div>
        )}

        {pages.length > 0 && (
          <nav className="flex flex-wrap items-center justify-center sm:justify-end text-center sm:text-right gap-x-3 gap-y-1 text-xs text-ink-2 sm:col-start-3 sm:justify-self-end"
               data-testid="footer-legal">
            {/* The separator TRAILS its link and is glued to it, rather than leading the
                next one. Leading separators read fine on one line and badly on two: at
                375px this row wraps, and every wrapped line began with a stray "·"
                hanging in the margin. Trailing ones end a line instead, which is what a
                reader expects from a list that continues.

                Every entry here is a CMS page marked "footer only" — including the
                consumer-protection links a jurisdiction requires. Nothing about ANPC or
                SAL is written into this file, which is what lets a deployment somewhere
                else carry its own. */}
            {pages.map((p, i) => (
              <span key={p.slug} className="inline-flex items-center gap-x-3 whitespace-nowrap">
                <Link to={`/${p.slug}`} className="hover:text-ink">{p.label}</Link>
                {i < pages.length - 1 && <span aria-hidden="true" className="text-ink-5">·</span>}
              </span>
            ))}
          </nav>
        )}
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
