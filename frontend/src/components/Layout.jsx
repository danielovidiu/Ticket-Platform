import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useAuth, startLogin } from "../auth";
import { http } from "../api";
import { Menu, X, ShoppingBag, ChevronDown, User } from "lucide-react";
import { useCart } from "../lib/cart";
import { loadNav, onNavChanged, readCachedNav } from "../lib/nav";

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
  { route: "/archive", label: "Archive" },
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

const Header = ({ cmsNav, navFailed }) => {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
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
      {/* One row, no wrapping. The account actions live behind a dropdown now, so the
          right-hand group is two controls at every role and in both auth states — the
          header can no longer change height or re-wrap when somebody signs in. The nav
          itself still grows with each CMS page, so it scrolls horizontally rather than
          pushing the row open. */}
      <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-5 flex items-center justify-between gap-x-6">
        <Link to="/" data-testid="logo-link" className="font-display text-xl md:text-2xl font-bold tracking-tighter uppercase shrink-0">
          SUPERSANITY
        </Link>
        <nav className="hidden lg:flex items-center gap-x-5 min-w-0 overflow-x-auto no-scrollbar font-mono-x text-[11px] uppercase tracking-[0.18em]">
          {nav.map((n) => (
            <NavLink key={n.route} to={n.route} end={n.route === "/"} data-testid={`nav-${n.label.toLowerCase()}`}
              className={({ isActive }) => `whitespace-nowrap ${isActive ? "text-ink" : "text-ink-3 hover:text-ink transition-colors"}`}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="hidden lg:flex items-center gap-2 shrink-0">
          <CartLink />
          <AccountMenu user={user} logout={logout} />
        </div>
        <button className="lg:hidden" data-testid="menu-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? <X /> : <Menu />}
        </button>
      </div>
      {open && (
        <div className="lg:hidden hairline-b bg-page">
          <div className="px-6 py-6 flex flex-col gap-4 font-mono-x uppercase text-sm">
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

const Footer = () => (
  <footer className="hairline mt-24">
    {/* Two columns before four: at md, quarter-width columns are narrower than
        the wordmark itself, which then spills into its neighbour. */}
    <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-14 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-10">
      <div>
        <div className="font-display text-2xl uppercase tracking-tighter">SUPERSANITY</div>
        <p className="mt-4 text-ink-3 text-sm max-w-xs">A Bucharest music &amp; performance collective. Programming, artists, box office — one door.</p>
      </div>
      <div>
        <div className="font-mono-x text-xs uppercase tracking-[0.2em] text-ink-4 mb-4">Legal</div>
        <ul className="space-y-2 text-sm text-ink-2">
          <li><Link to="/terms" className="hover:text-ink">Terms &amp; Conditions</Link></li>
          <li><Link to="/privacy" className="hover:text-ink">Privacy Policy</Link></li>
          <li><Link to="/cookie-policy" className="hover:text-ink">Cookie Policy</Link></li>
        </ul>
      </div>
      <div>
        <div className="font-mono-x text-xs uppercase tracking-[0.2em] text-ink-4 mb-4">Contact</div>
        {/* An address has no spaces to break at, so it needs an explicit rule
            to wrap instead of running past its column. */}
        <p className="text-ink-2 text-sm break-words">bookings@supersanity.collective</p>
      </div>
      <div className="font-mono-x text-xs text-ink-4">© {new Date().getFullYear()} Supersanity</div>
    </div>
  </footer>
);

export default function Layout({ children }) {
  // Seeded from the last nav this browser saw, read synchronously so a returning visitor
  // renders the real menu in the FIRST paint. Without it the header shows the built-in
  // sections and the authored pages appear a request later, which reads as the site
  // loading in two stages.
  const [cmsNav, setCmsNav] = useState(readCachedNav);
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
      <Header cmsNav={cmsNav} navFailed={navFailed} />
      <main className="flex-1 min-h-0">{children}</main>
      <Footer />
    </div>
  );
}
