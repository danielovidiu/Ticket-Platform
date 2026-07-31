import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useAuth, startLogin } from "../auth";
import { http } from "../api";
import { Menu, X, ShoppingBag, ChevronDown, User } from "lucide-react";
import { useCart } from "../lib/cart";
import { onNavChanged } from "../lib/nav";

/** Nav shown before /cms/nav answers.
 *
 * The bar is entirely CMS-ordered now, so the real one arrives a request late. Rendering
 * nothing until then made the header visibly reflow on every page load — the same fault
 * as the login jump, just triggered by latency instead of auth. These are the built-in
 * sections in their default order; the CMS list replaces them wholesale on arrival.
 */
const FALLBACK_NAV = [
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
              className="bg-[color:var(--accent)] text-black px-1.5 min-w-[18px] text-center font-mono-x text-[10px] leading-[16px]">
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
             className="absolute right-0 top-full mt-2 min-w-[180px] border border-white/15 bg-[color:var(--bg,#050505)] py-1 z-50">
          <div className="px-3 py-2 font-mono-x text-[10px] uppercase tracking-[0.2em] text-zinc-500 truncate">
            {user.email}
          </div>
          {linksFor(user).map((l) => (
            <Link key={l.to} to={l.to} role="menuitem" data-testid={l.testid}
                  className="block px-3 py-2 text-[11px] uppercase tracking-[0.18em] font-mono-x text-zinc-300 hover:text-white hover:bg-white/10">
              {l.label}
            </Link>
          ))}
          <button onClick={logout} role="menuitem" data-testid="logout-btn"
                  className="block w-full text-left px-3 py-2 text-[11px] uppercase tracking-[0.18em] font-mono-x text-zinc-300 hover:text-white hover:bg-white/10">
            Logout
          </button>
        </div>
      )}
    </div>
  );
};

const Header = ({ cmsNav }) => {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  // Order, labels and hrefs all come from the CMS now — see cms_routes.get_public_nav.
  const nav = cmsNav.length ? cmsNav : FALLBACK_NAV;
  return (
    <header className="sticky top-0 z-40 bg-[color:var(--bg,#050505)] hairline-b">
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
              className={({ isActive }) => `whitespace-nowrap ${isActive ? "text-white" : "text-zinc-400 hover:text-white transition-colors"}`}>
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
        <div className="lg:hidden hairline-b bg-[color:var(--bg,#050505)]">
          <div className="px-6 py-6 flex flex-col gap-4 font-mono-x uppercase text-sm">
            {nav.map((n) => <NavLink key={n.route} to={n.route} onClick={() => setOpen(false)} className="text-zinc-300">{n.label}</NavLink>)}
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
        <p className="mt-4 text-zinc-400 text-sm max-w-xs">A Bucharest music &amp; performance collective. Programming, artists, box office — one door.</p>
      </div>
      <div>
        <div className="font-mono-x text-xs uppercase tracking-[0.2em] text-zinc-500 mb-4">Legal</div>
        <ul className="space-y-2 text-sm text-zinc-300">
          <li><Link to="/terms" className="hover:text-white">Terms &amp; Conditions</Link></li>
          <li><Link to="/privacy" className="hover:text-white">Privacy Policy</Link></li>
          <li><Link to="/cookie-policy" className="hover:text-white">Cookie Policy</Link></li>
        </ul>
      </div>
      <div>
        <div className="font-mono-x text-xs uppercase tracking-[0.2em] text-zinc-500 mb-4">Contact</div>
        {/* An address has no spaces to break at, so it needs an explicit rule
            to wrap instead of running past its column. */}
        <p className="text-zinc-300 text-sm break-words">bookings@supersanity.collective</p>
      </div>
      <div className="font-mono-x text-xs text-zinc-500">© {new Date().getFullYear()} Supersanity</div>
    </div>
  </footer>
);

export default function Layout({ children }) {
  const [cmsNav, setCmsNav] = useState([]);
  const loadNav = useCallback(() => {
    http.get("/cms/nav").then((r) => setCmsNav(r.data)).catch(() => setCmsNav([]));
  }, []);
  // Load once, then again whenever the CMS says the nav changed. Layout never unmounts
  // during client-side navigation, so without the subscription an editor who reorders
  // pages and returns to the site keeps seeing the order from when the tab was opened.
  useEffect(() => {
    loadNav();
    return onNavChanged(loadNav);
  }, [loadNav]);
  // The header and footer are common to every page — including full-screen tools
  // like Scan and the CMS editor.
  return (
    <div className="min-h-screen flex flex-col">
      <div className="grain-overlay" />
      <Header cmsNav={cmsNav} />
      <main className="flex-1 min-h-0">{children}</main>
      <Footer />
    </div>
  );
}
