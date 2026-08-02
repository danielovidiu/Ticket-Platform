import React, { useEffect, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { http, API } from "../api";
import { useAuth, startLogin } from "../auth";
import { Link } from "react-router-dom";

const fmt = (iso) => new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export default function MyTickets() {
  const { user, loading } = useAuth();
  const [tickets, setTickets] = useState([]);
  const [invoices, setInvoices] = useState([]);

  useEffect(() => {
    if (!user) return;
    http.get("/my/tickets").then((r) => setTickets(r.data)).catch(() => {});
    http.get("/invoices/mine").then((r) => setInvoices(r.data)).catch(() => {});
  }, [user]);

  if (loading) return <div className="p-16 text-center text-ink-4 font-mono-x">Loading…</div>;
  if (!user) return (
    <div className="max-w-xl mx-auto px-6 py-24 text-center">
      <h1 className="font-display text-4xl uppercase font-black tracking-tighter">Sign in to view your tickets</h1>
      <button onClick={() => startLogin("/my-tickets")} data-testid="mytickets-login" className="btn-accent mt-8">SIGN IN</button>
    </div>
  );

  return (
    <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-16">
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">Wallet</div>
      <h1 className="font-display text-5xl md:text-7xl uppercase font-black tracking-tighter mt-2">My Tickets</h1>

      {tickets.length === 0 && <div className="mt-16 border border-dashed border-ink/10 p-12 text-center text-ink-4 font-mono-x uppercase text-xs tracking-[0.3em]">You have no tickets yet. <Link to="/events" className="text-ink underline ml-2">Browse events</Link></div>}

      <div className="mt-10 grid md:grid-cols-2 gap-6">
        {tickets.map((t) => (
          <div key={t.ticket_id} data-testid={`ticket-${t.qr_code}`} className="border border-ink/10 bg-surface p-6 flex gap-6">
            {/* Literally white, and deliberately NOT a theme token. QRCodeCanvas draws
                black modules, and a scanner needs both the high contrast and the pale
                quiet zone around the code. Under a light theme `bg-ink` would resolve to
                near-black and print a black code on a black card — an unscannable
                ticket at the door. */}
            <div className="bg-white p-3 flex items-center justify-center">
              <QRCodeCanvas value={t.qr_code} size={140} level="H" />
            </div>
            <div className="flex-1">
              <div className="font-mono-x text-[10px] uppercase tracking-[0.25em] text-ink-4">{t.event?.venue}</div>
              <div className="font-display text-2xl uppercase font-bold tracking-tighter mt-1">{t.event?.title}</div>
              <div className="font-mono-x text-xs text-ink-3 mt-2">{t.event && fmt(t.event.starts_at)}</div>
              <div className="font-mono-x text-[10px] uppercase tracking-[0.25em] mt-3">
                <span className={`px-2 py-1 border ${t.status==="issued" ? "border-ok text-ok" : t.status==="used" ? "border-ink-4 text-ink-3" : "border-brand text-brand"}`}>{t.status}</span>
              </div>
              <div className="font-mono-x text-[10px] uppercase tracking-[0.25em] text-ink-4 mt-3 break-all">{t.qr_code}</div>
            </div>
          </div>
        ))}
      </div>

      {invoices.length > 0 && (
        <div className="mt-24">
          <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">Fiscal</div>
          <h2 className="font-display text-3xl md:text-5xl uppercase font-bold tracking-tighter mt-2">Invoices</h2>
          <div className="mt-8 divide-y divide-ink/10 border-y border-ink/10">
            {invoices.map((i) => (
              <div key={i.invoice_id} className="grid grid-cols-12 gap-4 py-4 items-center">
                <div className="col-span-4 font-mono-x">{i.series}-{String(i.number).padStart(6, "0")}</div>
                <div className="col-span-4 font-mono-x text-xs text-ink-3">{new Date(i.issued_at).toLocaleDateString("en-GB")}</div>
                <div className="col-span-2 font-mono-x">{i.total.toFixed(2)} {i.currency}</div>
                <div className="col-span-2 text-right">
                  <a href={`${API}/invoices/${i.invoice_id}/pdf`} target="_blank" rel="noreferrer"
                     className="btn-primary inline-block" data-testid={`invoice-pdf-${i.invoice_id}`}>PDF</a>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
