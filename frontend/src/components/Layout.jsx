import React, { useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useAuth, startLogin } from "../auth";
import { Menu, X } from "lucide-react";

const NAV = [
  { to: "/", label: "Home" },
  { to: "/events", label: "Events" },
  { to: "/artists", label: "Artists" },
  { to: "/archive", label: "Archive" },
  { to: "/gallery", label: "Gallery" },
  { to: "/mission", label: "Mission" },
  { to: "/contact", label: "Contact" },
];

const Header = () => {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 bg-[#050505] hairline-b">
      <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-5 flex items-center justify-between">
        <Link to="/" data-testid="logo-link" className="font-display text-xl md:text-2xl font-bold tracking-tighter uppercase">
          UMBRA<span className="text-[color:var(--accent)]">/</span>COLLECTIVE
        </Link>
        <nav className="hidden md:flex items-center gap-7 font-mono-x text-xs uppercase tracking-[0.2em]">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} data-testid={`nav-${n.label.toLowerCase()}`}
              className={({ isActive }) => isActive ? "text-white" : "text-zinc-400 hover:text-white transition-colors"}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="hidden md:flex items-center gap-3">
          {user ? (
            <>
              <Link to="/my-tickets" data-testid="my-tickets-link" className="btn-primary">My Tickets</Link>
              {user.role === "admin" && <Link to="/admin" data-testid="admin-link" className="btn-primary">Admin</Link>}
              {(user.role === "admin" || user.role === "door") && <Link to="/scan" data-testid="scan-link" className="btn-primary">Scan</Link>}
              <button onClick={logout} data-testid="logout-btn" className="btn-primary">Logout</button>
            </>
          ) : (
            <button onClick={() => startLogin("/my-tickets")} data-testid="login-btn" className="btn-accent">Sign In</button>
          )}
        </div>
        <button className="md:hidden" data-testid="menu-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? <X /> : <Menu />}
        </button>
      </div>
      {open && (
        <div className="md:hidden hairline-b bg-[#050505]">
          <div className="px-6 py-6 flex flex-col gap-4 font-mono-x uppercase text-sm">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} onClick={() => setOpen(false)} className="text-zinc-300">{n.label}</NavLink>
            ))}
            {user ? (
              <>
                <Link to="/my-tickets" onClick={() => setOpen(false)}>My Tickets</Link>
                {user.role === "admin" && <Link to="/admin" onClick={() => setOpen(false)}>Admin</Link>}
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
        <div className="font-display text-2xl uppercase tracking-tighter">UMBRA<span className="text-[color:var(--accent)]">/</span>COLLECTIVE</div>
        <p className="mt-4 text-zinc-400 text-sm max-w-xs">A Bucharest music &amp; performance collective. Programming, artists, box office — one door.</p>
      </div>
      <div>
        <div className="font-mono-x text-xs uppercase tracking-[0.2em] text-zinc-500 mb-4">Navigate</div>
        <ul className="space-y-2 text-sm">
          {NAV.map((n) => <li key={n.to}><Link to={n.to} className="text-zinc-300 hover:text-white">{n.label}</Link></li>)}
        </ul>
      </div>
      <div>
        <div className="font-mono-x text-xs uppercase tracking-[0.2em] text-zinc-500 mb-4">Legal</div>
        <ul className="space-y-2 text-sm text-zinc-300">
          <li>All sales final unless event cancelled.</li>
          <li>Romanian VAT invoices auto-issued.</li>
          <li>Prices in RON.</li>
        </ul>
      </div>
      <div>
        <div className="font-mono-x text-xs uppercase tracking-[0.2em] text-zinc-500 mb-4">Contact</div>
        <p className="text-zinc-300 text-sm">bookings@umbra.collective</p>
        <p className="text-zinc-500 text-xs mt-6">© {new Date().getFullYear()} Umbra Collective</p>
      </div>
    </div>
  </footer>
);

export default function Layout({ children }) {
  const location = useLocation();
  const bare = location.pathname === "/scan";
  if (bare) return <>{children}</>;
  return (
    <div className="min-h-screen flex flex-col">
      <div className="grain-overlay" />
      <Header />
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}
