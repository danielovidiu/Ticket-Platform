import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { http } from "../api";
import { useAuth, startLogin } from "../auth";
import { useCart, ron } from "../lib/cart";

// Shown in the country picker. Romania first because it is the home market and its
// shipping rate differs; the rest are the EU zone.
const COUNTRIES = [
  ["RO", "Romania"], ["AT", "Austria"], ["BE", "Belgium"], ["BG", "Bulgaria"], ["HR", "Croatia"],
  ["CY", "Cyprus"], ["CZ", "Czechia"], ["DK", "Denmark"], ["EE", "Estonia"], ["FI", "Finland"],
  ["FR", "France"], ["DE", "Germany"], ["GR", "Greece"], ["HU", "Hungary"], ["IE", "Ireland"],
  ["IT", "Italy"], ["LV", "Latvia"], ["LT", "Lithuania"], ["LU", "Luxembourg"], ["MT", "Malta"],
  ["NL", "Netherlands"], ["PL", "Poland"], ["PT", "Portugal"], ["SK", "Slovakia"],
  ["SI", "Slovenia"], ["ES", "Spain"], ["SE", "Sweden"],
];

export default function ShopCheckout() {
  const { user, loading } = useAuth();
  const { cart, refresh } = useCart();
  const navigate = useNavigate();
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    full_name: "", phone: "", line1: "", line2: "", city: "", county: "", postal_code: "", country: "RO",
  });

  useEffect(() => { http.get("/shop/settings").then((r) => setSettings(r.data)).catch(() => {}); }, []);
  useEffect(() => { if (user) refresh(); }, [user, refresh]);

  // Prefill from the account — the mandatory profile already holds a name and phone.
  useEffect(() => {
    if (user) setForm((f) => ({
      ...f,
      full_name: f.full_name || user.name || "",
      phone: f.phone || user.phone || "",
    }));
  }, [user]);

  // Mirrors the server's rule so the buyer sees the real total before being sent to
  // Stripe. The server recomputes all of it — nothing here is trusted.
  const totals = useMemo(() => {
    if (!settings) return null;
    const subtotal = cart.subtotal_ron;
    const free = settings.free_over_ron > 0 && subtotal >= settings.free_over_ron;
    const shipping = free ? 0 : (form.country === "RO" ? settings.shipping_ro_ron : settings.shipping_eu_ron);
    const total = subtotal + shipping;
    const net = total / (1 + settings.vat_rate);
    return { subtotal, shipping, total, net, vat: total - net, zone: form.country === "RO" ? "RO" : "EU" };
  }, [settings, cart.subtotal_ron, form.country]);

  if (loading) return <div className="p-16 text-center font-mono-x text-ink-4">Loading…</div>;
  if (!user) return (
    <div className="max-w-xl mx-auto px-6 py-24 text-center">
      <h1 className="font-display text-3xl sm:text-4xl uppercase font-black tracking-tighter break-words">Sign in to check out</h1>
      <p className="mt-4 text-ink-3 text-sm">An account is required — it's where your order and invoice live.</p>
      <button onClick={() => startLogin("/shop/checkout")} className="btn-accent mt-8">SIGN IN</button>
    </div>
  );
  if (cart.items.length === 0) return (
    <div className="max-w-xl mx-auto px-6 py-24 text-center">
      <h1 className="font-display text-4xl uppercase font-black tracking-tighter">Your cart is empty</h1>
      <Link to="/shop" className="btn-primary mt-8 inline-block">Browse the shop</Link>
    </div>
  );

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { data } = await http.post("/shop/checkout", form);
      // Off to Stripe. The order exists as `pending` with its stock held until the
      // webhook confirms payment or the hold expires.
      window.location.href = data.url;
    } catch (err) {
      const d = err.response?.data?.detail;
      if (d?.reason === "profile_incomplete") {
        navigate("/complete-profile?return=%2Fshop%2Fcheckout");
        return;
      }
      if (d?.reason === "out_of_stock" || d?.reason === "cart_changed") {
        toast.error(d.detail || "Your cart changed — please review it");
        refresh();
        navigate("/cart");
        return;
      }
      toast.error(typeof d === "string" ? d : "Could not start the payment");
      setBusy(false);
    }
  };

  const Field = ({ label, k, required, type = "text", placeholder }) => (
    <label className="block">
      <div className="text-[10px] uppercase tracking-[0.2em] text-ink-4 mb-1 font-mono-x">{label}</div>
      <input type={type} required={required} value={form[k]} placeholder={placeholder}
             onChange={(e) => set(k, e.target.value)} data-testid={`ship-${k}`} className="input-x w-full" />
    </label>
  );

  return (
    <div className="max-w-[1100px] mx-auto px-6 md:px-10 py-16">
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">Merchandise</div>
      <h1 className="font-display text-4xl sm:text-5xl md:text-6xl uppercase font-black tracking-tighter mt-2">Checkout</h1>

      <form onSubmit={submit} className="mt-10 grid lg:grid-cols-12 gap-8 items-start">
        <div className="lg:col-span-7 border border-ink/10 bg-surface p-6 space-y-4">
          <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">Shipping address</div>
          <Field label="Full name" k="full_name" required />
          <Field label="Phone" k="phone" type="tel" placeholder="+40 721 234 567" />
          <Field label="Address" k="line1" required placeholder="Street and number" />
          <Field label="Address line 2" k="line2" placeholder="Block, flat, floor (optional)" />
          {/* One column until there is room for two. Two address fields side by side in
              a 375px viewport leave ~150px each, which truncates the placeholder before
              the user has typed anything. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="City" k="city" required />
            <Field label="County / region" k="county" />
          </div>
          {/* Same reason, and the country select is the worse case: its options are full
              country names, and a narrow select clips them rather than wrapping. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Postal code" k="postal_code" required />
            <label className="block">
              <div className="text-[10px] uppercase tracking-[0.2em] text-ink-4 mb-1 font-mono-x">Country</div>
              <select value={form.country} onChange={(e) => set("country", e.target.value)}
                      data-testid="ship-country" className="input-x w-full">
                {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
            </label>
          </div>
          <p className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 leading-relaxed pt-2">
            We ship to Romania and the EU. Your address is used for this delivery and kept with the order only.
          </p>
        </div>

        <div className="lg:col-span-5 border border-ink/10 bg-surface p-6 sticky top-24">
          <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">Order</div>
          <div className="mt-4 space-y-2">
            {cart.items.map((l) => (
              <div key={l.variant_id} className="flex justify-between gap-3 text-sm">
                <span className="min-w-0 break-words">
                  {l.name}{l.size ? ` · ${l.size}` : ""} <span className="text-ink-4">×{l.quantity}</span>
                </span>
                <span className="font-mono-x shrink-0">{ron(l.line_total_ron)}</span>
              </div>
            ))}
          </div>
          {totals && (
            <div className="mt-5 pt-4 border-t border-ink/10 space-y-2 font-mono-x text-sm">
              <div className="flex justify-between"><span className="text-ink-3">Subtotal</span><span>{ron(totals.subtotal)}</span></div>
              <div className="flex justify-between gap-3">
                <span className="text-ink-3 min-w-0 truncate">Shipping ({totals.zone})</span>
                <span data-testid="checkout-shipping" className="shrink-0">{totals.shipping === 0 ? "Free" : ron(totals.shipping)}</span>
              </div>
              <div className="flex justify-between text-base pt-2 border-t border-ink/10">
                <span>Total</span><span data-testid="checkout-total">{ron(totals.total)}</span>
              </div>
              {/* Romanian retail prices are quoted VAT-inclusive, so the split is shown
                  rather than added — the total above is what gets charged. */}
              <div className="flex justify-between gap-3 text-[10px] uppercase tracking-[0.2em] text-ink-4 pt-1">
                <span className="min-w-0">of which VAT ({Math.round(settings.vat_rate * 100)}%)</span>
                <span data-testid="checkout-vat" className="shrink-0">{ron(totals.vat)}</span>
              </div>
            </div>
          )}
          <button disabled={busy} data-testid="pay-now" className="btn-accent w-full mt-6 disabled:opacity-40">
            {busy ? "…" : "PAY WITH CARD"}
          </button>
          <p className="mt-3 font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 leading-relaxed">
            You'll be taken to Stripe. Stock is held for 20 minutes while you pay.
          </p>
        </div>
      </form>
    </div>
  );
}
