import React, { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { http } from "../api";
import { mediaUrl } from "../lib/media";
import { ron } from "../lib/cart";

const GENDERS = ["unisex", "men", "women"];

function ProductCard({ p }) {
  const cover = (p.images || [])[0];
  return (
    <Link to={`/shop/${p.slug}`} data-testid={`product-${p.slug}`}
          className="group flex flex-col h-full border border-white/10 hover:border-white transition-colors">
      <div className="aspect-square overflow-hidden relative shrink-0 bg-[#0F0F0F]">
        {cover ? (
          <img src={mediaUrl(cover)} alt={p.name} loading="lazy" decoding="async"
               className={`w-full h-full object-cover transition-opacity ${p.in_stock ? "group-hover:opacity-80" : "opacity-35"}`} />
        ) : (
          <div className="w-full h-full flex items-center justify-center font-mono-x text-[10px] uppercase tracking-[0.3em] text-zinc-600">No image</div>
        )}
        {!p.in_stock && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="bg-black/80 px-3 py-1.5 font-mono-x text-[10px] uppercase tracking-[0.25em] text-white">Sold out</span>
          </div>
        )}
      </div>
      <div className="flex-1 flex flex-col justify-between gap-2 p-3">
        <div className="font-display uppercase font-bold leading-tight">{p.name}</div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono-x text-sm">{ron(p.price_ron)}</span>
          <span className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-zinc-500">{p.category}</span>
        </div>
      </div>
    </Link>
  );
}

export default function Shop() {
  const [params, setParams] = useSearchParams();
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);

  // Filters live in the URL so a filtered view can be linked and survives a reload.
  const category = params.get("category") || "";
  const gender = params.get("gender") || "";
  const inStock = params.get("in_stock") === "1";

  useEffect(() => { http.get("/shop/categories").then((r) => setCategories(r.data)).catch(() => {}); }, []);

  useEffect(() => {
    const q = new URLSearchParams();
    if (category) q.set("category", category);
    if (gender) q.set("gender", gender);
    if (inStock) q.set("in_stock", "true");
    setLoading(true);
    http.get(`/shop/products${q.toString() ? `?${q}` : ""}`)
      .then((r) => setProducts(r.data))
      .catch(() => setProducts([]))
      .finally(() => setLoading(false));
  }, [category, gender, inStock]);

  const setFilter = (key, value) => {
    const next = new URLSearchParams(params);
    if (!value) next.delete(key); else next.set(key, value);
    setParams(next, { replace: true });
  };

  const filtered = useMemo(() => products, [products]);
  const anyFilter = category || gender || inStock;

  const Chip = ({ active, onClick, children, testId }) => (
    <button onClick={onClick} data-testid={testId}
            className={`px-3 py-1.5 border font-mono-x text-[10px] uppercase tracking-[0.2em] transition-colors ${
              active ? "bg-white text-black border-white" : "border-white/20 text-zinc-300 hover:border-white"}`}>
      {children}
    </button>
  );

  return (
    <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-16">
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">Merchandise</div>
      <h1 className="font-display text-5xl md:text-7xl uppercase font-black tracking-tighter mt-2">Shop</h1>

      <div className="mt-10 flex flex-wrap gap-2 items-center" data-testid="shop-filters">
        <Chip active={!category} onClick={() => setFilter("category", "")} testId="filter-all">All</Chip>
        {categories.map((c) => (
          <Chip key={c} active={category === c} onClick={() => setFilter("category", c)} testId={`filter-cat-${c}`}>{c}</Chip>
        ))}
        <span className="h-4 border-l border-white/15 mx-2" />
        {GENDERS.map((g) => (
          <Chip key={g} active={gender === g} onClick={() => setFilter("gender", gender === g ? "" : g)} testId={`filter-gender-${g}`}>{g}</Chip>
        ))}
        <span className="h-4 border-l border-white/15 mx-2" />
        <Chip active={inStock} onClick={() => setFilter("in_stock", inStock ? "" : "1")} testId="filter-instock">In stock</Chip>
        {anyFilter && (
          <button onClick={() => setParams(new URLSearchParams(), { replace: true })} data-testid="filter-clear"
                  className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-zinc-500 hover:text-white ml-1">Clear</button>
        )}
        <span className="ml-auto font-mono-x text-[10px] uppercase tracking-[0.2em] text-zinc-500">
          {loading ? "Loading…" : `${filtered.length} item${filtered.length === 1 ? "" : "s"}`}
        </span>
      </div>

      <div className="mt-8 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-6 items-stretch" data-testid="shop-grid">
        {filtered.map((p) => <ProductCard key={p.product_id} p={p} />)}
        {!loading && filtered.length === 0 && (
          <div className="col-span-full border border-dashed border-white/10 p-10 text-center text-zinc-500 font-mono-x text-xs uppercase tracking-[0.3em]">
            Nothing matches those filters
          </div>
        )}
      </div>
    </div>
  );
}
