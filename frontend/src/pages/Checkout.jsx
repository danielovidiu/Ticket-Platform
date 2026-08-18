import React, { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { http } from "../api";
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
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    http.get(`/reservations/${reservationId}`).then((r) => setRes(r.data)).catch(() => toast.error("Reservation not found"));
  }, [reservationId]);

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
          <div className="font-mono-x text-xs uppercase tracking-[0.2em] text-ink-3">Time remaining</div>
          <div data-testid="hold-timer" className="text-3xl font-bold text-brand">
            <Countdown expiresAt={res.expires_at} onExpire={() => toast.error("Hold expired — please reserve again")} />
          </div>
        </div>

        <div className="mt-6 space-y-3 font-mono-x text-sm">
          <div className="flex justify-between"><span className="text-ink-4 uppercase tracking-[0.2em] text-xs">Tickets</span><span>{res.quantity}</span></div>
          <div className="flex justify-between"><span className="text-ink-4 uppercase tracking-[0.2em] text-xs">Unit</span><span>{res.unit_price_ron.toFixed(2)} RON</span></div>
          <div className="flex justify-between"><span className="text-ink-4 uppercase tracking-[0.2em] text-xs">Subtotal</span><span>{res.subtotal_ron.toFixed(2)} RON</span></div>
          {res.discount_amount_ron > 0 && (
            <div className="flex justify-between text-ok">
              <span className="uppercase tracking-[0.2em] text-xs">Discount ({res.discount_percent}%)</span>
              <span>-{res.discount_amount_ron.toFixed(2)} RON</span>
            </div>
          )}
        </div>

        <div className="hairline mt-6 pt-6 flex justify-between items-center">
          <span className="font-mono-x uppercase text-xs tracking-[0.2em] text-ink-3">Total</span>
          <span className="font-display text-4xl font-black">{res.total_ron.toFixed(2)} RON</span>
        </div>

        <button onClick={goPay} disabled={busy || res.status !== "pending"} data-testid="pay-btn" className="btn-accent w-full mt-6">
          {busy ? "REDIRECTING…" : "PAY WITH CARD (STRIPE)"}
        </button>
        <button onClick={() => navigate("/events")} className="btn-primary w-full mt-3">Cancel</button>
      </div>
    </div>
  );
}
