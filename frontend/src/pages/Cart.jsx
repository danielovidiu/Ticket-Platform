import { useEffect, useState } from "react";
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

  if (loading) return <div className="p-16 text-center font-mono-x text-ink-4">Loading…</div>;
  if (!user) return (
    <div className="max-w-xl mx-auto px-6 py-24 text-center">
      <h1 className="font-display text-3xl sm:text-4xl uppercase font-black tracking-tighter break-words">Sign in to see your cart</h1>
      <p className="mt-4 text-ink-3 text-sm">Your cart is saved to your account, so it follows you between devices.</p>
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
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">Merchandise</div>
      <h1 className="font-display text-4xl sm:text-5xl md:text-6xl uppercase font-black tracking-tighter mt-2">Cart</h1>

      {empty ? (
        <div className="mt-12 border border-dashed border-ink/10 p-12 text-center">
          <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">Your cart is empty</div>
          <Link to="/shop" className="btn-primary mt-6 inline-block">Browse the shop</Link>
        </div>
      ) : (
        <div className="mt-10 grid lg:grid-cols-12 gap-8 items-start">
          <div className="lg:col-span-8 space-y-3" data-testid="cart-lines">
            {cart.items.map((l) => (
              /* One card per line item, two blocks inside it: what the thing is, and what
                 you can do to it. They stack on a phone and sit on one row from sm up.

                 Everything used to share a single wrapping flex row, so the name competed
                 for width with an 80px thumbnail and the quantity stepper and got about
                 135px — narrow enough that break-words shattered it mid-word
                 ("OBSIDIA / N / LONGSL / EEVE"). Splitting the row means the name gets the
                 full width beside the thumbnail (~227px at 375px) and wraps at spaces. */
              <div key={l.variant_id}
                   className={`border p-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4 ${
                     l.purchasable ? "border-ink/10 bg-surface" : "border-brand bg-surface"}`}
                   data-testid={`cart-line-${l.variant_id}`}>
                <div className="flex items-start gap-3 min-w-0 sm:flex-1">
                  <Link to={`/shop/${l.slug}`} className="w-16 h-16 sm:w-20 sm:h-20 shrink-0 overflow-hidden border border-ink/10">
                    {l.image ? <img src={mediaUrl(l.image)} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
                             : <div className="w-full h-full bg-surface-2" />}
                  </Link>
                  <div className="min-w-0 flex-1">
                    {/* block, so the link is a full-width line box rather than an inline
                        run the following text can crowd. break-words stays as the last
                        resort for a genuinely unbreakable name. */}
                    <Link to={`/shop/${l.slug}`}
                          className="block font-display uppercase font-bold leading-tight hover:underline break-words">
                      {l.name}
                    </Link>
                    {/* break-words: wide letter-spacing on a SKU pushes this past a 320px
                        card, and "M · TEE-OBS-M" has no plain space to wrap at. */}
                    <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 mt-1 break-words">
                      {[l.size, l.sku].filter(Boolean).join(" · ")}
                    </div>
                    {!l.purchasable && (
                      <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-brand mt-1">
                        {!l.published ? "No longer sold" : l.available === 0 ? "Sold out" : `Only ${l.available} left`}
                      </div>
                    )}
                  </div>
                </div>
                {/* Its own row on a phone, separated by a rule so the card reads as two
                    parts; inline and right-aligned once there is room. */}
                {/* flex-wrap with the amount and the remove button kept together: at 320px
                    the stepper, the amount and ✕ need ~262px against 248px of card, so the
                    pair drops to its own line instead of pushing the grid wider than the
                    screen. ml-auto keeps it right-aligned whichever line it lands on. */}
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 border-t border-ink/10 pt-3
                                sm:flex-nowrap sm:border-t-0 sm:pt-0 sm:justify-end sm:gap-x-4 sm:shrink-0">
                  <div className="flex items-center gap-2">
                    <button onClick={() => setQty(l, l.quantity - 1)} disabled={busy === l.variant_id || l.quantity <= 1}
                            className="btn-primary !py-1 !px-3 disabled:opacity-30" aria-label="Decrease quantity">−</button>
                    <span className="font-mono-x w-8 text-center" data-testid={`qty-${l.variant_id}`}>{l.quantity}</span>
                    <button onClick={() => setQty(l, l.quantity + 1)} disabled={busy === l.variant_id || l.quantity >= Math.min(20, l.available)}
                            className="btn-primary !py-1 !px-3 disabled:opacity-30" aria-label="Increase quantity">+</button>
                  </div>
                  <div className="flex items-center gap-2 ml-auto sm:gap-4">
                    {/* tabular-nums so amounts line up down the column instead of jittering. */}
                    <div className="font-mono-x text-sm text-right tabular-nums whitespace-nowrap sm:w-28">{ron(l.line_total_ron)}</div>
                    <button onClick={() => remove(l)} disabled={busy === l.variant_id}
                            data-testid={`remove-${l.variant_id}`}
                            aria-label={`Remove ${l.name}`}
                            className="btn-primary !py-1 !px-3 !text-[10px] hover:!text-brand">✕</button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="lg:col-span-4 border border-ink/10 bg-surface p-6 sticky top-24">
            <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">Summary</div>
            <div className="flex justify-between mt-4 font-mono-x text-sm">
              <span className="text-ink-3">Subtotal</span>
              <span data-testid="cart-subtotal">{ron(cart.subtotal_ron)}</span>
            </div>
            <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 mt-3 leading-relaxed">
              Shipping is calculated at checkout, once you choose a country. Prices include VAT.
            </div>
            {cart.has_problems && (
              <div className="mt-4 border border-brand p-3 font-mono-x text-[10px] uppercase tracking-[0.15em] text-brand leading-relaxed">
                Something changed while this sat in your cart. Fix the marked lines to continue.
              </div>
            )}
            <button onClick={() => navigate("/shop/checkout")} disabled={cart.has_problems}
                    data-testid="go-to-checkout" className="btn-accent w-full mt-6 disabled:opacity-40">
              CHECKOUT
            </button>
            <Link to="/shop" className="block text-center mt-4 font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 hover:text-ink">
              Keep shopping
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
