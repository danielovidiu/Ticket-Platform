import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { http, API } from "../api";
import { useAuth, startLogin } from "../auth";
import { ron } from "../lib/cart";

// The customer-facing half of the lifecycle. `pending` means the payment never landed
// and the hold has been released, so it is described as such rather than as an order.
const STATUS_LABEL = {
  pending: "Awaiting payment", paid: "Paid", shipped: "Shipped",
  delivered: "Delivered", cancelled: "Cancelled", refunded: "Refunded",
};
const STATUS_CLASS = {
  paid: "text-ok",
  shipped: "text-ink",
  delivered: "text-ok",
  pending: "text-ink-4",
  cancelled: "text-brand",
  refunded: "text-brand",
};

export default function MyOrders() {
  const { user, loading } = useAuth();
  const [orders, setOrders] = useState(null);

  useEffect(() => {
    if (!user) return;
    http.get("/shop/orders").then((r) => setOrders(r.data)).catch(() => setOrders([]));
  }, [user]);

  if (loading) return <div className="p-16 text-center font-mono-x text-ink-4">Loading…</div>;
  if (!user) return (
    <div className="max-w-xl mx-auto px-6 py-24 text-center">
      <h1 className="font-display text-3xl sm:text-4xl uppercase font-black tracking-tighter break-words">Sign in to see your orders</h1>
      <button onClick={() => startLogin("/my-orders")} className="btn-accent mt-8">SIGN IN</button>
    </div>
  );

  return (
    <div className="max-w-[1100px] mx-auto px-6 md:px-10 py-16">
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">Account</div>
      <h1 className="font-display text-4xl sm:text-5xl md:text-6xl uppercase font-black tracking-tighter mt-2">My Orders</h1>

      {orders === null ? (
        <div className="mt-10 font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">Loading…</div>
      ) : orders.length === 0 ? (
        <div className="mt-12 border border-dashed border-ink/10 p-12 text-center">
          <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">No orders yet</div>
          <Link to="/shop" className="btn-primary mt-6 inline-block">Browse the shop</Link>
        </div>
      ) : (
        <div className="mt-10 space-y-4" data-testid="orders-list">
          {orders.map((o) => (
            <div key={o.order_id} className="border border-ink/10 bg-surface p-5" data-testid={`order-${o.order_id}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 break-all">
                  {o.order_id} · {new Date(o.created_at).toLocaleDateString("en-GB")}
                </div>
                <div className={`font-mono-x text-[10px] uppercase tracking-[0.25em] ${STATUS_CLASS[o.status] || "text-ink-3"}`}>
                  {STATUS_LABEL[o.status] || o.status}
                </div>
              </div>

              <div className="mt-4 space-y-2">
                {o.items.map((l) => (
                  <div key={l.variant_id} className="flex items-center gap-3 text-sm">
                    <span className="min-w-0 flex-1 break-words">
                      {l.name}{l.size ? ` · ${l.size}` : ""} <span className="text-ink-4">×{l.quantity}</span>
                    </span>
                    <span className="font-mono-x shrink-0">{ron(l.line_total_ron)}</span>
                  </div>
                ))}
              </div>

              <div className="mt-4 pt-3 border-t border-ink/10 flex flex-wrap items-center justify-between gap-3">
                <div className="font-mono-x text-xs text-ink-3">
                  Shipping ({o.shipping_zone}) {ron(o.shipping_ron)} · <span className="text-ink">Total {ron(o.total_ron)}</span>
                  <span className="text-ink-4"> · incl. VAT {ron(o.vat_amount_ron)}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {o.tracking_number && (
                    <span className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-3 self-center">
                      {o.carrier} {o.tracking_number}
                    </span>
                  )}
                  {o.invoice_id && (
                    <a href={`${API}/invoices/${o.invoice_id}/pdf`} target="_blank" rel="noreferrer"
                       data-testid={`invoice-${o.order_id}`} className="btn-primary !py-1.5 !px-3 !text-[10px]">
                      Invoice PDF
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
