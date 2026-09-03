import { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { http } from "../api";
import { ron } from "../lib/money";
import { toast } from "sonner";

function Countdown({ expiresAt, onExpire }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, new Date(expiresAt).getTime() - Date.now()));
  useEffect(() => {
    const id = setInterval(() => {
      const r = Math.max(0, new Date(expiresAt).getTime() - Date.now());
      setRemaining(r);
      if (r === 0) { clearInterval(id); onExpire?.(); }
    }, 500);
    return () => clearInterval(id);
  }, [expiresAt, onExpire]);
  const m = Math.floor(remaining / 60000);
  const s = Math.floor((remaining % 60000) / 1000);
  return <span className="font-mono-x tabular-nums">{String(m).padStart(2,"0")}:{String(s).padStart(2,"0")}</span>;
}

export default function Checkout() {
  const { reservationId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);

  /* The event this hold belongs to, so an expired hold can send the buyer back to the
     page that can make them a new one. The reservation document carries an event_id but
     no slug, so EventDetail hands the slug over in navigation state — which a reload or
     a pasted link does not preserve, hence the /events fallback. */
  const eventSlug = location.state?.eventSlug || null;

  useEffect(() => {
    http.get(`/reservations/${reservationId}`).then((r) => setRes(r.data)).catch(() => toast.error("Reservation not found"));
  }, [reservationId]);

  /* A hold can already be dead when the page opens — a backgrounded tab reopened an hour
     later, or a link followed late. Deciding this from the fetched reservation rather
     than waiting for the ticking countdown means the pay button is never briefly live on
     a reservation the server will refuse. */
  useEffect(() => {
    if (res) setExpired(new Date(res.expires_at).getTime() <= Date.now());
  }, [res]);

  /* Stable identity: Countdown's effect lists onExpire in its dependencies, so a fresh
     closure every render tore down and rebuilt the interval on each of its own ticks. */
  const handleExpire = useCallback(() => setExpired(true), []);

  const goPay = async () => {
    setBusy(true);
    try {
      const { data } = await http.post("/checkout", { reservation_id: reservationId });
      window.location.href = data.url;
    } catch (e) {
      // /checkout answers with a plain string, but the account gates on the reservation
      // route use an object — guard so an error never renders as "[object Object]".
      const detail = e.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : "Checkout failed");
      setBusy(false);
    }
  };

  if (!res) return <div className="p-16 text-center text-ink-4 font-mono-x uppercase text-xs tracking-[0.3em]">Loading…</div>;

  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">Reservation Hold</div>
      <h1 className="font-display text-4xl md:text-5xl uppercase font-black tracking-tighter mt-2">Confirm & Pay</h1>

      <div className="mt-8 border border-ink/10 bg-surface p-6">
        <div className="flex items-center justify-between hairline-b pb-4">
          <div className="font-mono-x text-xs uppercase tracking-[0.2em] text-ink-3">
            {expired ? "Hold expired" : "Time remaining"}
          </div>
          <div data-testid="hold-timer"
               className={`text-3xl font-bold ${expired ? "text-ink-4 line-through" : "text-brand"}`}>
            <Countdown expiresAt={res.expires_at} onExpire={handleExpire} />
          </div>
        </div>

        <div className="mt-6 space-y-3 font-mono-x text-sm">
          {/* `quantity` is tickets and `pack_count` is what was bought, and on a group
              tier those differ — one 300 RON pack, four tickets. Both are named, because
              the buyer is about to pay the pack price and walk away with the tickets, and
              a summary showing only one of the two numbers reads as an error either way. */}
          <div className="flex justify-between"><span className="text-ink-4 uppercase tracking-[0.2em] text-xs">Tickets</span><span>{res.quantity}</span></div>
          {res.pack_size > 1 && (
            <div className="flex justify-between" data-testid="checkout-packs">
              <span className="text-ink-4 uppercase tracking-[0.2em] text-xs">Packs</span>
              <span>{res.pack_count} × {res.pack_size}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-ink-4 uppercase tracking-[0.2em] text-xs">
              {res.pack_size > 1 ? `Per pack of ${res.pack_size}` : "Unit"}
            </span>
            <span>{ron(res.unit_price_ron)}</span>
          </div>
          <div className="flex justify-between"><span className="text-ink-4 uppercase tracking-[0.2em] text-xs">Subtotal</span><span>{ron(res.subtotal_ron)}</span></div>
          {res.discount_amount_ron > 0 && (
            <div className="flex justify-between text-ok">
              <span className="uppercase tracking-[0.2em] text-xs">Discount ({res.discount_percent}%)</span>
              <span>-{ron(res.discount_amount_ron)}</span>
            </div>
          )}
        </div>

        <div className="hairline mt-6 pt-6 flex justify-between items-center">
          <span className="font-mono-x uppercase text-xs tracking-[0.2em] text-ink-3">Total</span>
          <span className="font-display text-4xl font-black">{ron(res.total_ron)}</span>
        </div>

        {/* A dead hold swaps the action out rather than greying it out. The old button
            stayed enabled once the countdown hit zero — `res` is fetched once, so its
            `status` was still "pending" long after the server had released the stock —
            and the buyer's tap bought them a rejected request instead of a ticket. */}
        {expired ? (
          <div className="mt-6" data-testid="hold-expired" role="status">
            <div className="border border-brand p-4 text-center font-mono-x text-[11px] uppercase tracking-[0.25em] text-brand">
              Stock released · nothing was charged
            </div>
            <button onClick={() => navigate(eventSlug ? `/events/${eventSlug}` : "/events")}
                    data-testid="reserve-again-btn" className="btn-accent w-full mt-3">
              RESERVE AGAIN
            </button>
          </div>
        ) : (
          <>
            <button onClick={goPay} disabled={busy || res.status !== "pending"} data-testid="pay-btn" className="btn-accent w-full mt-6">
              {busy ? "REDIRECTING…" : "PAY WITH CARD (STRIPE)"}
            </button>
            <button onClick={() => navigate("/events")} className="btn-primary w-full mt-3">Cancel</button>
          </>
        )}
      </div>
    </div>
  );
}
