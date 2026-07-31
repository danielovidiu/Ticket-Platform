import React, { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { http } from "../api";
import { useAuth, startLogin } from "../auth";
import { mediaUrl } from "../lib/media";
import { useCart, ron } from "../lib/cart";

export default function Cart() {
  const { user, loading } = useAuth();
  const { cart, refresh, setCart } = useCart();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const [busy, setBusy] = useState(null);

  useEffect(() => { if (user) refresh(); }, [user, refresh]);

  // Coming back from an abandoned Stripe session. The order stays pending until its hold
  // expires and the stock is returned; nothing to do here but explain.
  useEffect(() => {
    if (search.get("cancelled")) toast("Payment cancelled — your cart is untouched");
  }, [search]);

  if (loading) return <div className="p-16 text-center font-mono-x text-zinc-500">Loading…</div>;
  if (!user) return (
    <div className="max-w-xl mx-auto px-6 py-24 text-center">
      <h1 className="font-display text-3xl sm:text-4xl uppercase font-black tracking-tighter break-words">Sign in to see your cart</h1>
      <p className="mt-4 text-zinc-400 text-sm">Your cart is saved to your account, so it follows you between devices.</p>
      <button onClick={() => startLogin("/cart")} className="btn-accent mt-8">SIGN IN</button>
    </div>
  );

  const mutate = async (fn, key) => {
    setBusy(key);
    try {
      const { data } = await fn();
      setCart(data);
    } catch (e) {
      const d = e.response?.data?.detail;
      toast.error(typeof d === "string" ? d : "Could not update your cart");
      refresh();
    } finally {
      setBusy(null);
    }
  };

  const setQty = (line, quantity) =>
    mutate(() => http.patch(`/shop/cart/items/${line.variant_id}`, { quantity }), line.variant_id);
  const remove = (line) =>
    mutate(() => http.delete(`/shop/cart/items/${line.variant_id}`), line.variant_id);

  const empty = cart.items.length === 0;

  return (
    <div className="max-w-[1100px] mx-auto px-6 md:px-10 py-16">
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">Merchandise</div>
      <h1 className="font-display text-4xl sm:text-5xl md:text-6xl uppercase font-black tracking-tighter mt-2">Cart</h1>

      {empty ? (
        <div className="mt-12 border border-dashed border-white/10 p-12 text-center">
          <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">Your cart is empty</div>
          <Link to="/shop" className="btn-primary mt-6 inline-block">Browse the shop</Link>
        </div>
      ) : (
        <div className="mt-10 grid lg:grid-cols-12 gap-8 items-start">
          <div className="lg:col-span-8 space-y-3" data-testid="cart-lines">
            {cart.items.map((l) => (
              <div key={l.variant_id}
                   className={`border p-3 flex flex-wrap sm:flex-nowrap items-center gap-4 ${
                     l.purchasable ? "border-white/10 bg-[#0F0F0F]" : "border-[color:var(--accent)] bg-[#0F0F0F]"}`}
                   data-testid={`cart-line-${l.variant_id}`}>
                <Link to={`/shop/${l.slug}`} className="w-20 h-20 shrink-0 overflow-hidden border border-white/10">
                  {l.image ? <img src={mediaUrl(l.image)} alt="" className="w-full h-full object-cover" />
                           : <div className="w-full h-full bg-[#151515]" />}
                </Link>
                <div className="min-w-0 flex-1">
                  <Link to={`/shop/${l.slug}`} className="font-display uppercase font-bold hover:underline break-words">{l.name}</Link>
                  {/* break-words: wide letter-spacing on a SKU pushes this past a 320px
                      card, and "M · TEE-OBS-M" has no plain space to wrap at. */}
                  <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-zinc-500 mt-1 break-words">
                    {[l.size, l.sku].filter(Boolean).join(" · ")}
                  </div>
                  {!l.purchasable && (
                    <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-[color:var(--accent)] mt-1">
                      {!l.published ? "No longer sold" : l.available === 0 ? "Sold out" : `Only ${l.available} left`}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setQty(l, l.quantity - 1)} disabled={busy === l.variant_id || l.quantity <= 1}
                          className="btn-primary !py-1 !px-3 disabled:opacity-30" aria-label="Decrease quantity">−</button>
                  <span className="font-mono-x w-8 text-center" data-testid={`qty-${l.variant_id}`}>{l.quantity}</span>
                  <button onClick={() => setQty(l, l.quantity + 1)} disabled={busy === l.variant_id || l.quantity >= Math.min(20, l.available)}
                          className="btn-primary !py-1 !px-3 disabled:opacity-30" aria-label="Increase quantity">+</button>
                </div>
                <div className="font-mono-x text-sm w-28 text-right">{ron(l.line_total_ron)}</div>
                <button onClick={() => remove(l)} disabled={busy === l.variant_id}
                        data-testid={`remove-${l.variant_id}`}
                        className="btn-primary !py-1 !px-3 !text-[10px] hover:!text-[color:var(--accent)]">✕</button>
              </div>
            ))}
          </div>

          <div className="lg:col-span-4 border border-white/10 bg-[#0F0F0F] p-6 sticky top-24">
            <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">Summary</div>
            <div className="flex justify-between mt-4 font-mono-x text-sm">
              <span className="text-zinc-400">Subtotal</span>
              <span data-testid="cart-subtotal">{ron(cart.subtotal_ron)}</span>
            </div>
            <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-zinc-500 mt-3 leading-relaxed">
              Shipping is calculated at checkout, once you choose a country. Prices include VAT.
            </div>
            {cart.has_problems && (
              <div className="mt-4 border border-[color:var(--accent)] p-3 font-mono-x text-[10px] uppercase tracking-[0.15em] text-[color:var(--accent)] leading-relaxed">
                Something changed while this sat in your cart. Fix the marked lines to continue.
              </div>
            )}
            <button onClick={() => navigate("/shop/checkout")} disabled={cart.has_problems}
                    data-testid="go-to-checkout" className="btn-accent w-full mt-6 disabled:opacity-40">
              CHECKOUT
            </button>
            <Link to="/shop" className="block text-center mt-4 font-mono-x text-[10px] uppercase tracking-[0.2em] text-zinc-500 hover:text-white">
              Keep shopping
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
