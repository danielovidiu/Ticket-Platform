import React, { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { http } from "../api";
import { useCart, ron } from "../lib/cart";

/**
 * Landing page after Stripe. Polls the transaction until the payment is confirmed.
 *
 * The poll is a convenience for the person watching the screen, not the mechanism —
 * the webhook is what actually marks the order paid, server-side, and it will do so
 * whether or not this page is ever loaded.
 */
export default function ShopSuccess() {
  const [search] = useSearchParams();
  const sessionId = search.get("session_id");
  const { refresh } = useCart();
  const [state, setState] = useState("checking"); // checking | paid | pending | error
  const [order, setOrder] = useState(null);
  const attempts = useRef(0);

  useEffect(() => {
    if (!sessionId) { setState("error"); return undefined; }
    let stop = false;

    const tick = async () => {
      attempts.current += 1;
      try {
        const { data } = await http.get(`/payments/status/${sessionId}`);
        if (stop) return;
        if (data.payment_status === "paid") {
          setState("paid");
          refresh(); // the server empties the cart on payment; sync the badge
          if (data.order_id) {
            try {
              const o = await http.get(`/shop/orders/${data.order_id}`);
              if (!stop) setOrder(o.data);
            } catch { /* the confirmation stands even if this read fails */ }
          }
          return;
        }
      } catch { /* keep polling — the webhook may still be in flight */ }
      if (!stop) {
        // Give up on the poll after ~30s and tell the truth: payment may well have
        // succeeded, and the order page is authoritative.
        if (attempts.current > 15) setState("pending");
        else setTimeout(tick, 2000);
      }
    };
    tick();
    return () => { stop = true; };
  }, [sessionId, refresh]);

  return (
    <div className="max-w-2xl mx-auto px-6 py-24">
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">Merchandise</div>
      <h1 className="font-display text-5xl uppercase font-black tracking-tighter mt-2" data-testid="shop-success-heading">
        {state === "paid" ? "Order confirmed" : state === "error" ? "Something went wrong" : state === "pending" ? "Still processing" : "Confirming…"}
      </h1>

      <p className="mt-6 text-zinc-300 text-sm leading-relaxed">
        {state === "paid" && "Payment received. We've emailed you a receipt, and your invoice is on your orders page."}
        {state === "checking" && "One moment while we confirm the payment with Stripe."}
        {state === "pending" && "Your payment is taking a little longer to confirm. It will appear on your orders page as soon as it lands — no need to pay again."}
        {state === "error" && "We couldn't find that payment session. If you were charged, your order will still appear on your orders page."}
      </p>

      {order && (
        <div className="mt-8 border border-white/10 bg-[#0F0F0F] p-6" data-testid="success-order">
          <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-zinc-500">Order {order.order_id}</div>
          <div className="mt-4 space-y-2">
            {order.items.map((l) => (
              <div key={l.variant_id} className="flex justify-between gap-3 text-sm">
                <span>{l.name}{l.size ? ` · ${l.size}` : ""} <span className="text-zinc-500">×{l.quantity}</span></span>
                <span className="font-mono-x">{ron(l.line_total_ron)}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 pt-3 border-t border-white/10 font-mono-x text-sm flex justify-between">
            <span>Total paid</span><span>{ron(order.total_ron)}</span>
          </div>
        </div>
      )}

      <div className="mt-10 flex flex-wrap gap-3">
        <Link to="/my-orders" className="btn-accent" data-testid="success-orders-link">MY ORDERS</Link>
        <Link to="/shop" className="btn-primary">Keep shopping</Link>
      </div>
    </div>
  );
}
