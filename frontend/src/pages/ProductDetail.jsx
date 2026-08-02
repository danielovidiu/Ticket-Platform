import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { toast } from "sonner";
import { http } from "../api";
import { useAuth, startLogin } from "../auth";
import { mediaUrl } from "../lib/media";
import { useCart, ron } from "../lib/cart";

export default function ProductDetail() {
  const { slug } = useParams();
  const { user } = useAuth();
  const { refresh } = useCart();
  const [p, setP] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [variantId, setVariantId] = useState(null);
  const [imgIdx, setImgIdx] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    http.get(`/shop/products/${slug}`)
      .then((r) => {
        setP(r.data);
        // Preselect the first size that can actually be bought, so the primary action
        // isn't disabled on arrival for a product that's mostly in stock.
        const first = r.data.variants.find((v) => v.in_stock) || r.data.variants[0];
        setVariantId(first ? first.variant_id : null);
      })
      .catch(() => setNotFound(true));
  }, [slug]);

  if (notFound) return (
    <div className="max-w-xl mx-auto px-6 py-24 text-center">
      <h1 className="font-display text-4xl uppercase font-black tracking-tighter">Not found</h1>
      <Link to="/shop" className="btn-primary mt-8 inline-block">Back to shop</Link>
    </div>
  );
  if (!p) return <div className="p-16 text-center text-ink-4 font-mono-x uppercase text-xs tracking-[0.3em]">Loading…</div>;

  const variant = p.variants.find((v) => v.variant_id === variantId) || null;
  const images = p.images || [];

  const addToCart = async () => {
    if (!user) {
      // An account is required to check out, so sign-in is the honest first step rather
      // than filling a cart that can't be paid for.
      startLogin(`/shop/${slug}`);
      return;
    }
    if (!variant) { toast.error("Pick a size"); return; }
    setBusy(true);
    try {
      await http.post("/shop/cart/items", { product_id: p.product_id, variant_id: variant.variant_id, quantity: 1 });
      await refresh();
      toast.success(`${p.name}${variant.size ? ` · ${variant.size}` : ""} added`);
    } catch (e) {
      const d = e.response?.data?.detail;
      toast.error(typeof d === "string" ? d : "Could not add that to your cart");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-12 grid md:grid-cols-12 gap-10">
      <div className="md:col-span-7">
        <div className="aspect-square overflow-hidden border border-ink/10 bg-surface">
          {images[imgIdx] ? (
            <img src={mediaUrl(images[imgIdx])} alt={p.name} className="w-full h-full object-cover" data-testid="product-image" />
          ) : (
            <div className="w-full h-full flex items-center justify-center font-mono-x text-xs uppercase tracking-[0.3em] text-ink-5">No image</div>
          )}
        </div>
        {images.length > 1 && (
          <div className="mt-2 flex gap-2">
            {images.map((src, i) => (
              <button key={src + i} onClick={() => setImgIdx(i)}
                      className={`w-20 h-20 overflow-hidden border ${i === imgIdx ? "border-ink" : "border-ink/10"}`}>
                <img src={mediaUrl(src)} alt="" className="w-full h-full object-cover" />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="md:col-span-5">
        <div className="border border-ink/10 bg-surface p-6 md:p-8 sticky top-24">
          <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">
            {[p.category, p.gender].filter(Boolean).join(" · ")}
          </div>
          <h1 data-testid="product-title" className="font-display text-4xl uppercase font-black tracking-tighter mt-2 leading-none">{p.name}</h1>
          <div className="font-mono-x text-xl mt-4">{ron(p.price_ron)}</div>
          <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 mt-1">VAT included</div>

          {p.description && <p className="mt-6 text-ink-2 text-sm leading-relaxed">{p.description}</p>}

          <div className="mt-8">
            <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 mb-2">Size</div>
            <div className="flex flex-wrap gap-2" data-testid="size-picker">
              {p.variants.map((v) => (
                <button
                  key={v.variant_id}
                  onClick={() => v.in_stock && setVariantId(v.variant_id)}
                  disabled={!v.in_stock}
                  title={v.in_stock ? v.size : `${v.size} — sold out`}
                  data-testid={`size-${v.size}`}
                  className={`px-4 py-2 border font-mono-x text-xs uppercase tracking-[0.15em] transition-colors ${
                    v.variant_id === variantId ? "bg-ink text-page border-ink"
                      : v.in_stock ? "border-ink/25 text-ink-2 hover:border-ink"
                      : "border-ink/10 text-ink-5 line-through cursor-not-allowed"}`}>
                  {v.size || "One size"}
                </button>
              ))}
            </div>
            {variant && <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-5 mt-2">SKU {variant.sku}</div>}
          </div>

          <button onClick={addToCart} disabled={busy || !p.in_stock || !variant?.in_stock}
                  data-testid="add-to-cart" className="btn-accent w-full mt-8 disabled:opacity-40">
            {!p.in_stock ? "SOLD OUT" : busy ? "…" : user ? "ADD TO CART" : "SIGN IN TO BUY"}
          </button>

          <div className="mt-4 font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 leading-relaxed">
            Ships from Bucharest · Romania &amp; EU · 14-day returns
          </div>
        </div>
      </div>
    </div>
  );
}
