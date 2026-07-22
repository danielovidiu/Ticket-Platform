import React, { useEffect, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { useAuth, startLogin } from "../auth";
import { http } from "../api";
import { Menu, X } from "lucide-react";

// These routes are always present in nav — CMS pages fold in-between and after.
const CORE_NAV_BEFORE = [];
const CORE_NAV_AFTER = [
  { to: "/events", label: "Events" },
  { to: "/artists", label: "Artists" },
  { to: "/archive", label: "Archive" },
  { to: "/gallery", label: "Gallery" },
];

const Header = ({ cmsNav }) => {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const nav = [
    ...CORE_NAV_BEFORE,
    ...cmsNav.map((p) => ({ to: p.slug === "home" ? "/" : (p.slug === "mission" ? "/mission" : p.slug === "contact" ? "/contact" : `/p/${p.slug}`), label: p.label })),
    ...CORE_NAV_AFTER,
  ];
  return (
    <header className="sticky top-0 z-40 bg-[color:var(--bg,#050505)] hairline-b">
      <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-5 flex items-center justify-between">
        <Link to="/" data-testid="logo-link" className="font-display text-xl md:text-2xl font-bold tracking-tighter uppercase">
          SUPERSANITY
        </Link>
        <nav className="hidden lg:flex items-center gap-5 font-mono-x text-[11px] uppercase tracking-[0.18em]">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === "/"} data-testid={`nav-${n.label.toLowerCase()}`}
              className={({ isActive }) => isActive ? "text-white" : "text-zinc-400 hover:text-white transition-colors"}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="hidden lg:flex items-center gap-2">
          {user ? (
            <>
              <Link to="/my-tickets" data-testid="my-tickets-link" className="btn-primary !py-2 !px-3 !text-[10px]">My Tickets</Link>
              <Link to="/settings" data-testid="settings-link" className="btn-primary !py-2 !px-3 !text-[10px]">Account</Link>
              {user.role === "admin" && <Link to="/admin" data-testid="admin-link" className="btn-primary !py-2 !px-3 !text-[10px]">Admin</Link>}
              {(user.role === "admin" || user.role === "editor") && <Link to="/cms" data-testid="cms-link" className="btn-primary !py-2 !px-3 !text-[10px]">CMS</Link>}
              {(user.role === "admin" || user.role === "door") && <Link to="/scan" data-testid="scan-link" className="btn-primary !py-2 !px-3 !text-[10px]">Scan</Link>}
              <button onClick={logout} data-testid="logout-btn" className="btn-primary !py-2 !px-3 !text-[10px]">Logout</button>
            </>
          ) : (
            <button onClick={() => startLogin("/my-tickets")} data-testid="login-btn" className="btn-accent">Sign In</button>
          )}
        </div>
        <button className="lg:hidden" data-testid="menu-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? <X /> : <Menu />}
        </button>
      </div>
      {open && (
        <div className="lg:hidden hairline-b bg-[color:var(--bg,#050505)]">
          <div className="px-6 py-6 flex flex-col gap-4 font-mono-x uppercase text-sm">
            {nav.map((n) => <NavLink key={n.to} to={n.to} onClick={() => setOpen(false)} className="text-zinc-300">{n.label}</NavLink>)}
            {user ? (
              <>
                <Link to="/my-tickets" onClick={() => setOpen(false)}>My Tickets</Link>
                <Link to="/settings" onClick={() => setOpen(false)}>Account</Link>
                {user.role === "admin" && <Link to="/admin" onClick={() => setOpen(false)}>Admin</Link>}
                {(user.role === "admin" || user.role === "editor") && <Link to="/cms" onClick={() => setOpen(false)}>CMS</Link>}
                {(user.role === "admin" || user.role === "door") && <Link to="/scan" onClick={() => setOpen(false)}>Scan</Link>}
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
    <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-14 grid grid-cols-1 md:grid-cols-4 gap-10">
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
        <p className="text-zinc-300 text-sm">bookings@supersanity.collective</p>
      </div>
      <div className="font-mono-x text-xs text-zinc-500">© {new Date().getFullYear()} Supersanity</div>
    </div>
  </footer>
);

export default function Layout({ children }) {
  const [cmsNav, setCmsNav] = useState([]);
  useEffect(() => {
    http.get("/cms/nav").then((r) => setCmsNav(r.data)).catch(() => setCmsNav([]));
  }, []);
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
