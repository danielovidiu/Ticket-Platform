import { useEffect, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { X } from "lucide-react";
import { http, API } from "../api";
import { numericDate } from "../lib/dates";
import { money } from "../lib/money";
import { useAuth, startLogin } from "../auth";
import { Link } from "react-router-dom";

const fmt = (iso) => new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/* One canvas, drawn well above the size it is displayed at, so the same element can be a
   140px thumbnail beside the details and a near-fullscreen code at the door without
   resampling into mush. CSS decides the display size; this is the backing store. */
const QR_RENDER_PX = 640;

/**
 * The code, as large as the screen allows.
 *
 * The door is the scene this whole page exists for: someone holding a phone at arm's
 * length, in the dark, while a queue waits. The card's inline code is for recognising
 * which ticket you are on; this is for being read by a scanner.
 *
 * A screen wake lock is held while it is open — the default sleep timeout is the classic
 * way a ticket goes black in the half second before it is scanned. Brightness cannot be
 * raised from the web at all, so that part is still on the visitor.
 */
function TicketZoom({ ticket, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    /* The request is async, so a close that lands first must still release: `released`
       covers the window between asking for the lock and being handed it. */
    let lock = null;
    let released = false;
    const wakeLock = navigator.wakeLock;
    if (wakeLock) {
      wakeLock.request("screen")
        .then((l) => { if (released) l.release().catch(() => {}); else lock = l; })
        .catch(() => { /* denied, or the tab lost focus — not worth surfacing */ });
    }

    return () => {
      released = true;
      lock?.release().catch(() => {});
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[80] bg-page flex flex-col" data-testid="ticket-zoom"
         role="dialog" aria-modal="true" aria-label="Ticket QR code">
      <div className="flex items-center justify-between px-6 py-4 border-b border-ink/15"
           style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }}>
        <div className="min-w-0">
          <div className="font-mono-x text-[10px] uppercase tracking-[0.25em] text-ink-4 truncate">{ticket.event?.venue}</div>
          <div className="font-display text-xl uppercase font-bold tracking-tighter truncate">{ticket.event?.title}</div>
        </div>
        <button onClick={onClose} data-testid="ticket-zoom-close" aria-label="Close"
                className="shrink-0 ml-4 border border-ink/20 p-3 hover:bg-ink hover:text-page transition-colors">
          <X size={20} />
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 gap-6">
        {/* White, not a theme token, for the same reason the card is: the scanner needs
            the black modules and the pale quiet zone whichever way the site is themed. */}
        <div className="bg-white p-4">
          <QRCodeCanvas value={ticket.qr_code} size={QR_RENDER_PX} level="H"
                        style={{ width: "min(78vw, 52vh)", height: "min(78vw, 52vh)", display: "block" }} />
        </div>
        <div className="font-mono-x text-xs uppercase tracking-[0.25em] text-ink-3 break-all text-center max-w-full">
          {ticket.qr_code}
        </div>
      </div>

      <div className="px-6 pb-6 text-center font-mono-x text-[10px] uppercase tracking-[0.25em] text-ink-4"
           style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}>
        Turn your screen brightness up before you reach the door
      </div>
    </div>
  );
}

export default function MyTickets() {
  const { user, loading } = useAuth();
  const [tickets, setTickets] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [zoomed, setZoomed] = useState(null);

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
          /* Stacked on a phone, side by side once there is room.
             The row layout used to apply at every width: a 140px code plus its padding
             took 164px of a 279px card, leaving under 100px for a text-2xl event title,
             which wrapped to pieces. The card is the door surface — it gets the width. */
          <div key={t.ticket_id} data-testid={`ticket-${t.qr_code}`}
               className="border border-ink/10 bg-surface p-6 flex flex-col sm:flex-row gap-6">
            {/* Literally white, and deliberately NOT a theme token. QRCodeCanvas draws
                black modules, and a scanner needs both the high contrast and the pale
                quiet zone around the code. Under a light theme `bg-ink` would resolve to
                near-black and print a black code on a black card — an unscannable
                ticket at the door. */}
            <button onClick={() => setZoomed(t)} data-testid={`ticket-zoom-${t.qr_code}`}
                    aria-label={`Enlarge QR code for ${t.event?.title || "this ticket"}`}
                    className="bg-white p-3 self-center sm:self-start shrink-0 block">
              {/* The wrapper carries the responsive size, not the canvas: QRCodeCanvas
                  writes width/height inline from `size`, and an inline style outranks a
                  class, so `w-[220px]` on the canvas itself is silently ignored. */}
              <span className="block w-[220px] h-[220px] sm:w-[140px] sm:h-[140px]">
                <QRCodeCanvas value={t.qr_code} size={QR_RENDER_PX} level="H"
                              style={{ width: "100%", height: "100%", display: "block" }} />
              </span>
            </button>
            <div className="flex-1 min-w-0">
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
                <div className="col-span-4 font-mono-x text-xs text-ink-3">{numericDate(i.issued_at)}</div>
                <div className="col-span-2 font-mono-x">{money(i.total)} {i.currency}</div>
                <div className="col-span-2 text-right">
                  <a href={`${API}/invoices/${i.invoice_id}/pdf`} target="_blank" rel="noreferrer"
                     className="btn-primary inline-block" data-testid={`invoice-pdf-${i.invoice_id}`}>PDF</a>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {zoomed && <TicketZoom ticket={zoomed} onClose={() => setZoomed(null)} />}
    </div>
  );
}
