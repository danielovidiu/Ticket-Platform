import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { http } from "../api";
import { mediaUrl } from "../lib/media";
import { ron } from "../lib/cart";
import ImageField from "./ImageField";

const SIZES = ["XS", "S", "M", "L", "XL", "XXL", "ONE SIZE"];
// A-Z. SIZES above is deliberately NOT sorted: XS..XXL is a scale, and alphabetical
// would render it L, M, ONE SIZE, S, XL, XS, XXL.
const GENDERS = ["men", "unisex", "women"];
const CATEGORIES = ["accessories", "apparel", "music", "print"];

// Only these can be set by hand — `paid` comes from a confirmed payment and nothing else.
const NEXT_STATUS = { paid: ["shipped", "cancelled"], shipped: ["delivered"] };
const STATUS_CLASS = {
  pending: "text-ink-4", paid: "text-ok", shipped: "text-ink",
  delivered: "text-ok", cancelled: "text-brand",
  refunded: "text-brand", expired: "text-ink-5",
};

const errText = (e, fallback) => {
  const d = e.response?.data?.detail;
  return typeof d === "string" ? d : fallback;
};

function Field({ label, className = "", children }) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <div className="text-[10px] text-ink-4 mb-1 font-mono-x uppercase tracking-[0.2em]">{label}</div>
      {children}
    </label>
  );
}

// ---------------- Products ----------------

function ProductForm({ form, setForm, onSave, onClose }) {
  /* Every one of these reads the form it is handed rather than one captured when the
     handler was built. Nothing here writes twice in a single action today, so none of them
     was visibly broken — but the event form's setters looked exactly this safe right up
     until one action wrote two fields, and then a just-uploaded image vanished with no
     error to explain it. The functional form costs nothing and cannot lose an update. */
  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setVariant = (i, k, v) => setForm((f) => {
    const rows = [...f.variants];
    rows[i] = { ...rows[i], [k]: v };
    return { ...f, variants: rows };
  });
  const addVariant = () => setForm((f) => ({
    ...f,
    // A blank SKU is rejected server-side; prefill a sensible guess from the name.
    variants: [...f.variants, { size: "M", sku: `${(f.name || "SKU").slice(0, 3).toUpperCase()}-${f.variants.length + 1}`, stock: 0 }],
  }));
  const removeVariant = (i) => setForm((f) => ({ ...f, variants: f.variants.filter((_, k) => k !== i) }));

  return (
    <div className="fixed inset-0 z-50 bg-[rgba(5,5,5,0.9)] flex items-center justify-center p-4">
      <div className="border border-ink/20 bg-surface w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="shrink-0 flex flex-wrap gap-3 justify-between items-center hairline-b px-6 py-4">
          <div className="font-display text-2xl uppercase font-bold">{form.product_id ? "Edit" : "New"} product</div>
          <div className="flex gap-2">
            <button onClick={onSave} data-testid="save-product-btn" className="btn-accent">SAVE</button>
            <button onClick={onClose} className="btn-primary">CLOSE</button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" className="col-span-2">
              <input value={form.name} onChange={(e) => setF("name", e.target.value)} className="input-x w-full" data-testid="product-name" />
            </Field>
            <Field label="Slug (blank = from name)" className="col-span-2">
              <input value={form.slug} onChange={(e) => setF("slug", e.target.value)} placeholder="obsidian-tee" className="input-x w-full font-mono-x" />
            </Field>
            <Field label="Price (RON, VAT included)">
              <input type="number" step="0.01" value={form.price_ron}
                     onChange={(e) => setF("price_ron", Number(e.target.value))} className="input-x w-full" data-testid="product-price" />
            </Field>
            <Field label="Category">
              <input list="shop-categories" value={form.category} onChange={(e) => setF("category", e.target.value)} className="input-x w-full" />
              <datalist id="shop-categories">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
            </Field>
            <Field label="Gender">
              <select value={form.gender} onChange={(e) => setF("gender", e.target.value)} className="input-x w-full">
                {GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </Field>
            <Field label="Sort order">
              <input type="number" value={form.sort_order} onChange={(e) => setF("sort_order", Number(e.target.value))} className="input-x w-full" />
            </Field>
            <div className="col-span-2">
              <div className="text-[10px] text-ink-4 mb-1 font-mono-x uppercase tracking-[0.2em]">Description</div>
              <textarea value={form.description} onChange={(e) => setF("description", e.target.value)} rows={3} className="input-x w-full" />
            </div>
            <label className="col-span-2 flex gap-2 items-center">
              <input type="checkbox" checked={form.is_published} onChange={(e) => setF("is_published", e.target.checked)} data-testid="product-published" />
              <span className="text-sm">Published</span>
            </label>
          </div>

          <div className="mt-6 hairline-b pb-2 font-mono-x uppercase tracking-[0.2em] text-xs text-ink-4">Images</div>
          <div className="mt-3 space-y-3">
            {(form.images || []).map((src, i) => (
              <div key={i} className="flex gap-2 items-end">
                <div className="flex-1">
                  <ImageField label={`Image ${i + 1}`} value={src} testId={`product-image-${i}`}
                              onChange={(v) => setF("images", form.images.map((x, k) => (k === i ? v : x)))} />
                </div>
                <button onClick={() => setF("images", form.images.filter((_, k) => k !== i))}
                        className="btn-primary !text-[10px] mb-1">Remove</button>
              </div>
            ))}
            <button onClick={() => setF("images", [...(form.images || []), ""])} className="btn-primary">+ Add image</button>
          </div>

          <div className="mt-8 hairline-b pb-2 flex items-baseline gap-3">
            <div className="font-display text-xl uppercase font-bold">Sizes &amp; stock</div>
            <div className="font-mono-x uppercase tracking-[0.2em] text-[10px] text-ink-4">
              {form.variants.length} variant{form.variants.length === 1 ? "" : "s"}
            </div>
          </div>
          <div className="mt-3 space-y-2" data-testid="variant-rows">
            {form.variants.map((v, i) => (
              <div key={v.variant_id || i} className="grid grid-cols-12 gap-2 items-end border border-ink/10 p-3">
                <Field label="Size" className="col-span-3">
                  <input list="shop-sizes" value={v.size} onChange={(e) => setVariant(i, "size", e.target.value.toUpperCase())}
                         className="input-x w-full" data-testid={`variant-size-${i}`} />
                </Field>
                <Field label="SKU" className="col-span-5">
                  <input value={v.sku} onChange={(e) => setVariant(i, "sku", e.target.value.toUpperCase())}
                         className="input-x w-full font-mono-x" data-testid={`variant-sku-${i}`} />
                </Field>
                <Field label="Stock" className="col-span-2">
                  <input type="number" min="0" value={v.stock} onChange={(e) => setVariant(i, "stock", Number(e.target.value))}
                         className="input-x w-full" data-testid={`variant-stock-${i}`} />
                </Field>
                <div className="col-span-2">
                  <button onClick={() => removeVariant(i)} className="btn-primary w-full !text-[10px]">Remove</button>
                </div>
              </div>
            ))}
            <datalist id="shop-sizes">{SIZES.map((s) => <option key={s} value={s} />)}</datalist>
            <button onClick={addVariant} className="btn-primary" data-testid="add-variant">+ Add size</button>
            {/* Stock shown here is what is sellable right now: a checkout in progress has
                already taken its units out, and puts them back if it is never paid. */}
            <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 pt-1">
              Stock excludes units held by checkouts in progress.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ShopProducts() {
  const [items, setItems] = useState([]);
  const [form, setForm] = useState(null);
  const load = () => http.get("/admin/shop/products").then((r) => setItems(r.data)).catch(() => setItems([]));
  useEffect(() => { load(); }, []);

  const emptyForm = () => ({
    name: "", slug: "", description: "", images: [""], price_ron: 149, category: "apparel",
    gender: "unisex", is_published: true, sort_order: 100,
    variants: [{ size: "M", sku: "", stock: 0 }],
  });

  const save = async () => {
    try {
      const body = { ...form, images: (form.images || []).filter(Boolean) };
      if (form.product_id) {
        // Strip the server-owned fields; the rest is the patch.
        const { product_id: _pid, created_at: _created, ...patch } = body;
        await http.patch(`/admin/shop/products/${form.product_id}`, patch);
      } else {
        await http.post("/admin/shop/products", body);
      }
      setForm(null); load(); toast.success("Saved");
    } catch (e) { toast.error(errText(e, "Could not save")); }
  };

  const del = async (p) => {
    if (!window.confirm(`Delete "${p.name}"?`)) return;
    try {
      const { data } = await http.delete(`/admin/shop/products/${p.product_id}`);
      toast.success(data.unpublished ? data.reason : "Deleted");
      load();
    } catch (e) { toast.error(errText(e, "Could not delete")); }
  };

  const seed = async () => {
    try {
      const { data } = await http.post("/admin/shop/seed");
      toast[data.seeded ? "success" : "error"](data.seeded ? `Seeded ${data.products} products` : data.reason);
      load();
    } catch (e) { toast.error(errText(e, "Could not seed")); }
  };

  const stockOf = (p) => (p.variants || []).reduce((n, v) => n + (v.stock || 0), 0);

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => setForm(emptyForm())} data-testid="new-product-btn" className="btn-accent">+ NEW PRODUCT</button>
        {items.length === 0 && <button onClick={seed} className="btn-primary" data-testid="seed-shop-btn">Seed demo catalogue</button>}
        <span className="ml-auto self-center font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4">
          {items.length} product{items.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="mt-6 space-y-2">
        {items.map((p) => (
          <div key={p.product_id} className="border border-ink/10 bg-surface p-3 grid grid-cols-1 lg:grid-cols-12 gap-3 lg:gap-2 lg:items-center">
            <div className="lg:col-span-1">
              <div className="w-12 h-12 overflow-hidden border border-ink/10">
                {p.images?.[0] ? <img src={mediaUrl(p.images[0])} alt="" className="w-full h-full object-cover" />
                               : <div className="w-full h-full bg-surface-2" />}
              </div>
            </div>
            <div className="lg:col-span-4 min-w-0 font-display font-bold uppercase break-words">{p.name}</div>
            <div className="lg:col-span-2 min-w-0 font-mono-x text-xs text-ink-3">{p.category} · {p.gender}</div>
            <div className="lg:col-span-1 min-w-0 font-mono-x text-xs">{ron(p.price_ron)}</div>
            <div className={`lg:col-span-1 min-w-0 font-mono-x text-xs ${stockOf(p) === 0 ? "text-brand" : "text-ink-2"}`}>
              {stockOf(p)} in stock
            </div>
            <div className={`lg:col-span-1 min-w-0 font-mono-x text-[10px] uppercase tracking-[0.2em] ${p.is_published ? "text-ok" : "text-ink-4"}`}>
              {p.is_published ? "Live" : "Draft"}
            </div>
            <div className="lg:col-span-2 min-w-0 flex flex-wrap gap-2 lg:justify-end">
              <button onClick={() => setForm({ ...emptyForm(), ...p })} className="btn-primary text-xs">Edit</button>
              <button onClick={() => del(p)} className="btn-primary text-xs">Del</button>
            </div>
          </div>
        ))}
        {items.length === 0 && (
          <div className="border border-dashed border-ink/10 p-8 text-center font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4">
            No products yet
          </div>
        )}
      </div>

      {form && <ProductForm form={form} setForm={setForm} onSave={save} onClose={() => setForm(null)} />}
    </div>
  );
}

// ---------------- Orders ----------------

export function ShopOrders() {
  const [orders, setOrders] = useState([]);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(null);
  const [tracking, setTracking] = useState({ carrier: "", tracking_number: "" });

  const load = useCallback(() => http.get(`/admin/shop/orders${filter ? `?status=${filter}` : ""}`)
    .then((r) => setOrders(r.data)).catch(() => setOrders([])), [filter]);
  useEffect(() => { load(); }, [load]);

  const advance = async (o, status) => {
    if (status === "cancelled" && !window.confirm("Cancel this order? Stock goes back on sale.")) return;
    try {
      await http.patch(`/admin/shop/orders/${o.order_id}`, {
        status,
        ...(status === "shipped" ? tracking : {}),
      });
      toast.success(`Marked ${status}`);
      setOpen(null); setTracking({ carrier: "", tracking_number: "" });
      load();
    } catch (e) { toast.error(errText(e, "Could not update the order")); }
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2 items-center mb-4">
        {["", "paid", "shipped", "delivered", "cancelled"].map((s) => (
          <button key={s || "all"} onClick={() => setFilter(s)} data-testid={`order-filter-${s || "all"}`}
                  className={`px-3 py-1.5 border font-mono-x text-[10px] uppercase tracking-[0.2em] ${
                    filter === s ? "bg-ink text-page border-ink" : "border-ink/20 text-ink-2"}`}>
            {s || "all"}
          </button>
        ))}
        <span className="ml-auto font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4">
          {orders.length} order{orders.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="space-y-2">
        {orders.map((o) => {
          const addr = o.shipping_address || {};
          return (
            <div key={o.order_id} className="border border-ink/10 bg-surface p-3" data-testid={`admin-order-${o.order_id}`}>
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 lg:gap-2 lg:items-center">
                <div className="lg:col-span-3 min-w-0 font-mono-x text-xs break-all">{o.order_id}</div>
                <div className="lg:col-span-2 min-w-0 text-sm break-words">{addr.full_name || o.email}</div>
                <div className="lg:col-span-1 min-w-0 font-mono-x text-xs">{o.shipping_zone}</div>
                <div className="lg:col-span-2 min-w-0 font-mono-x text-xs">{ron(o.total_ron)}</div>
                <div className={`lg:col-span-1 min-w-0 font-mono-x text-[10px] uppercase tracking-[0.2em] ${STATUS_CLASS[o.status]}`}>{o.status}</div>
                <div className="lg:col-span-3 min-w-0 flex flex-wrap gap-2 lg:justify-end">
                  <button onClick={() => setOpen(open === o.order_id ? null : o.order_id)} className="btn-primary text-xs">
                    {open === o.order_id ? "Hide" : "Details"}
                  </button>
                  {(NEXT_STATUS[o.status] || []).map((s) => (
                    <button key={s} onClick={() => advance(o, s)} data-testid={`order-${s}-${o.order_id}`}
                            className={s === "cancelled" ? "btn-primary text-xs" : "btn-accent !py-1.5 !px-3 !text-xs"}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              {open === o.order_id && (
                <div className="mt-4 pt-3 border-t border-ink/10 grid md:grid-cols-2 gap-6 text-sm">
                  <div>
                    <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 mb-2">Items</div>
                    {o.items.map((l) => (
                      <div key={l.variant_id} className="flex justify-between gap-3 py-0.5">
                        <span className="min-w-0 break-words">{l.name}{l.size ? ` · ${l.size}` : ""} <span className="text-ink-4">×{l.quantity}</span></span>
                        <span className="font-mono-x shrink-0">{ron(l.line_total_ron)}</span>
                      </div>
                    ))}
                    <div className="mt-2 pt-2 border-t border-ink/10 font-mono-x text-xs text-ink-3">
                      Sub {ron(o.subtotal_ron)} · Ship {ron(o.shipping_ron)} · <span className="text-ink">Total {ron(o.total_ron)}</span>
                      <br />Net {ron(o.net_ron)} + VAT {ron(o.vat_amount_ron)}
                    </div>
                  </div>
                  <div>
                    <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 mb-2">Ship to</div>
                    <div className="text-ink-2 leading-relaxed">
                      {addr.full_name}<br />{addr.line1}{addr.line2 ? <>, {addr.line2}</> : null}<br />
                      {addr.postal_code} {addr.city}{addr.county ? `, ${addr.county}` : ""}<br />
                      {addr.country}<br />{addr.phone}
                    </div>
                    {o.status === "paid" && (
                      <div className="mt-4 grid grid-cols-2 gap-2">
                        <input placeholder="Carrier" value={tracking.carrier}
                               onChange={(e) => setTracking({ ...tracking, carrier: e.target.value })}
                               className="input-x" data-testid="tracking-carrier" />
                        <input placeholder="Tracking number" value={tracking.tracking_number}
                               onChange={(e) => setTracking({ ...tracking, tracking_number: e.target.value })}
                               className="input-x font-mono-x" data-testid="tracking-number" />
                        <div className="col-span-2 font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4">
                          Filled in before marking shipped — both go in the customer's email.
                        </div>
                      </div>
                    )}
                    {o.tracking_number && (
                      <div className="mt-3 font-mono-x text-xs text-ink-3">{o.carrier} · {o.tracking_number}</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {orders.length === 0 && (
          <div className="border border-dashed border-ink/10 p-8 text-center font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4">
            No orders
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------- Settings ----------------

export function ShopSettings() {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { http.get("/admin/shop/settings").then((r) => setS(r.data)).catch(() => setS(null)); }, []);
  if (!s) return null;

  const save = async () => {
    setBusy(true);
    try {
      const { data } = await http.patch("/admin/shop/settings", s);
      setS(data);
      toast.success("Shop settings saved");
    } catch (e) { toast.error(errText(e, "Could not save")); }
    finally { setBusy(false); }
  };

  return (
    <div className="border border-ink/10 bg-surface p-4 max-w-2xl" data-testid="shop-settings">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Shipping — Romania (RON)">
          <input type="number" step="0.01" value={s.shipping_ro_ron} data-testid="ship-ro"
                 onChange={(e) => setS({ ...s, shipping_ro_ron: Number(e.target.value) })} className="input-x w-full" />
        </Field>
        <Field label="Shipping — rest of EU (RON)">
          <input type="number" step="0.01" value={s.shipping_eu_ron} data-testid="ship-eu"
                 onChange={(e) => setS({ ...s, shipping_eu_ron: Number(e.target.value) })} className="input-x w-full" />
        </Field>
        <Field label="Free shipping over (0 = off)">
          <input type="number" step="0.01" value={s.free_over_ron}
                 onChange={(e) => setS({ ...s, free_over_ron: Number(e.target.value) })} className="input-x w-full" />
        </Field>
        <Field label="VAT rate — sitewide (0.21 = 21%)">
          <input type="number" step="0.01" min="0" max="0.99" value={s.vat_rate} data-testid="vat-rate"
                 onChange={(e) => setS({ ...s, vat_rate: Number(e.target.value) })} className="input-x w-full" />
        </Field>
        <label className="col-span-2 flex gap-2 items-center">
          <input type="checkbox" checked={s.shop_enabled} onChange={(e) => setS({ ...s, shop_enabled: e.target.checked })} />
          <span className="text-sm">Shop open (unchecked blocks new checkouts)</span>
        </label>
      </div>
      <button onClick={save} disabled={busy} className="btn-accent mt-4 disabled:opacity-40" data-testid="save-shop-settings">
        {busy ? "…" : "SAVE SETTINGS"}
      </button>
      <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 mt-3 leading-relaxed">
        Prices are entered VAT-inclusive — the rate only splits net from VAT on invoices, it is
        never added on top. It applies to tickets as well as the shop, and takes effect on the
        next order: invoices already issued keep the rate they were raised under.
      </div>
    </div>
  );
}
