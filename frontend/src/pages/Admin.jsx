import React, { useEffect, useRef, useState } from "react";
import { http, API } from "../api";
import { useAuth } from "../auth";
import { toast } from "sonner";
import { Link } from "react-router-dom";
import { DateTimePicker } from "../components/ui/datetime-picker";
import { FormatToolbar } from "../lib/richText";
import { SOCIAL_PLATFORMS } from "../lib/social";
import AlbumManager from "../components/AlbumManager";
import ImageField from "../components/ImageField";
import { ShopProducts, ShopOrders, ShopSettings } from "../components/ShopAdmin";

const TABS = ["stats", "events", "orders", "shop", "shop orders", "shop settings",
              "artists", "projects", "discounts", "invites", "users", "gallery", "newsletter"];

export default function Admin() {
  const { user, loading } = useAuth();
  const [tab, setTab] = useState("stats");

  if (loading) return <div className="p-16 text-center font-mono-x text-ink-4">Loading…</div>;
  if (!user || user.role !== "admin") return <div className="p-16 text-center font-mono-x">Access denied. Admin only.</div>;

  return (
    <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-10">
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">Backstage</div>
      <h1 className="font-display text-4xl md:text-6xl uppercase font-black tracking-tighter mt-2">Admin</h1>
      <div className="mt-6 flex flex-wrap gap-2 hairline-b pb-4">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} data-testid={`admin-tab-${t}`}
                  className={`px-3 py-2 border font-mono-x text-xs uppercase tracking-[0.2em] ${tab===t ? "bg-ink text-page border-ink" : "border-ink/20 text-ink-2"}`}>{t}</button>
        ))}
      </div>
      <div className="mt-8">
        {tab === "stats" && <Stats />}
        {tab === "events" && <Events />}
        {tab === "orders" && <Orders />}
        {tab === "shop" && <ShopProducts />}
        {tab === "shop orders" && <ShopOrders />}
        {tab === "shop settings" && <ShopSettings />}
        {tab === "artists" && <Artists />}
        {tab === "projects" && <Projects />}
        {tab === "discounts" && <Discounts />}
        {tab === "invites" && <Invites />}
        {tab === "users" && <Users />}
        {tab === "gallery" && <GalleryAdmin />}
        {tab === "newsletter" && <NewsletterAdmin />}
      </div>
    </div>
  );
}

// Quick ranges are resolved at click time (not module load) so a long-open
// admin tab doesn't keep filtering against the day it was opened.
const STAT_PRESETS = [
  ["7 days", () => 7],
  ["30 days", () => 30],
  ["90 days", () => 90],
];
const isoDay = (d) => d.toISOString().slice(0, 10);

function Stats() {
  const [s, setS] = useState(null);
  const [events, setEvents] = useState([]);
  const [eventId, setEventId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  useEffect(() => { http.get("/admin/events").then((r) => setEvents(r.data)).catch(() => setEvents([])); }, []);
  useEffect(() => {
    const p = new URLSearchParams();
    if (eventId) p.set("event_id", eventId);
    if (dateFrom) p.set("date_from", dateFrom);
    if (dateTo) p.set("date_to", dateTo);
    const qs = p.toString();
    http.get(`/admin/stats${qs ? `?${qs}` : ""}`).then((r) => setS(r.data));
  }, [eventId, dateFrom, dateTo]);

  const setLastDays = (n) => {
    const to = new Date();
    const from = new Date(to.getTime() - n * 864e5);
    setDateFrom(isoDay(from));
    setDateTo(isoDay(to));
  };
  const clear = () => { setEventId(""); setDateFrom(""); setDateTo(""); };
  const filtered = eventId || dateFrom || dateTo;

  const cards = s && [
    ["Revenue", `${s.revenue_ron.toFixed(2)} RON`],
    ["Orders", s.total_orders],
    ["Tickets issued", s.total_tickets],
    ["Scanned", s.scanned],
    [filtered ? "Events with sales" : "Events", s.events],
  ];

  return (
    <div>
      <div className="border border-ink/10 bg-surface p-4 mb-4" data-testid="stats-filters">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Field label="Event">
            <select value={eventId} onChange={(e) => setEventId(e.target.value)} className="input-x w-full" data-testid="stats-event-filter">
              <option value="">All events</option>
              {events.map((e) => <option key={e.event_id} value={e.event_id}>{e.title}</option>)}
            </select>
          </Field>
          <Field label="From">
            <input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} className="input-x w-full" data-testid="stats-date-from" />
          </Field>
          <Field label="To">
            <input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} className="input-x w-full" data-testid="stats-date-to" />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2 items-center mt-3">
          {STAT_PRESETS.map(([label, days]) => (
            <button key={label} onClick={() => setLastDays(days())} className="btn-primary text-xs">Last {label}</button>
          ))}
          {filtered && <button onClick={clear} className="btn-primary text-xs" data-testid="stats-clear">Clear</button>}
          <span className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 ml-auto">
            {filtered ? "Filtered" : "All time · all events"}
          </span>
        </div>
      </div>
      {!s ? <div>Loading</div> : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          {cards.map(([k, v]) => (
            <div key={k} className="border border-ink/10 bg-surface p-4 lg:p-6 min-w-0">
              <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-ink-4 break-words">{k}</div>
              {/* Revenue can run to six figures plus a currency suffix — it must be
                  free to shrink and wrap rather than push past the card. */}
              <div className="font-display text-2xl lg:text-3xl font-black mt-2 break-words">{v}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// An event is "past" once it ends (falling back to its start time when no end
// is set) — matches the same rule the public /events feed uses, so admin status
// never disagrees with what visitors actually see.
function eventStatus(e) {
  if (!e.is_published) return "DRAFT";
  const endMoment = e.ends_at || e.starts_at;
  return new Date(endMoment) < new Date() ? "PAST" : "LIVE";
}
const STATUS_CLASS = {
  LIVE: "text-ok",
  PAST: "text-ink-4",
  DRAFT: "text-brand",
};

// Ticket tiers read as full words in the admin form — the abbreviated values
// ("gen", "early") are storage detail, not something an editor should decode.
const TIER_LABEL = { early_bird: "Early Bird", general: "General", vip: "VIP" };
const TIER_BADGE = {
  early_bird: "border-ok text-ok",
  general: "border-ink/50 text-ink",
  vip: "border-brand text-brand",
};

// Small labelled wrapper so every field in the tier card says what it is.
function Field({ label, className = "", children }) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <div className="text-[10px] text-ink-4 mb-1 font-mono-x uppercase tracking-[0.2em]">{label}</div>
      {children}
    </label>
  );
}

function Events() {
  const [events, setEvents] = useState([]);
  const [form, setForm] = useState(null);
  const [notice, setNotice] = useState(null);   // { event, kind } while composing
  const load = () => http.get("/admin/events").then((r) => setEvents(r.data));
  useEffect(() => { load(); }, []);
  const emptyForm = () => ({ title: "", slug: "", description: "", venue: "", city: "", starts_at: "", ends_at: "", doors_open_at: "", image_url: "", artist_ids: [], max_tickets_per_user: 4, is_published: true, sold_out_message: "", waves: [{ name: "GENERAL", price_ron: 100, capacity: 100, starts_at: new Date().toISOString(), ends_at: new Date(Date.now()+30*864e5).toISOString(), tier: "general", access_from: "" }] });
  const save = async () => {
    try {
      if (form.event_id) {
        const body = {...form}; delete body.created_at;
        await http.patch(`/admin/events/${form.event_id}`, body);
      } else await http.post("/admin/events", form);
      setForm(null); load(); toast.success("Saved");
    } catch (e) { toast.error(e.response?.data?.detail || "Failed"); }
  };
  const del = async (id) => { if (!confirm("Delete?")) return; await http.delete(`/admin/events/${id}`); load(); };
  // Cancelling refunds every issued ticket. It used to do that in silence; now it hands
  // straight over to the composer so the holders actually hear about it — still a
  // deliberate send, with the admin writing the words.
  const cancel = async (e) => {
    if (!confirm("Cancel event? All tickets refunded.")) return;
    await http.post(`/admin/events/${e.event_id}/cancel`);
    load();
    setNotice({ event: e, kind: "cancelled" });
  };

  return (
    <div>
      <button onClick={() => setForm(emptyForm())} data-testid="new-event-btn" className="btn-accent">+ NEW EVENT</button>
      <div className="mt-6 space-y-2">
        {events.map((e) => (
          // Stacked rows on narrow screens; the dense 12-column layout only kicks
          // in at lg, where there is actually room for five columns of text.
          // `min-w-0` lets each cell shrink below its content width, without which
          // grid children refuse to shrink and spill over their neighbours.
          <div key={e.event_id} className="border border-ink/10 bg-surface p-4 grid grid-cols-1 lg:grid-cols-12 gap-3 lg:gap-2 lg:items-center">
            <div className="lg:col-span-4 min-w-0 font-display font-bold uppercase break-words lg:truncate">{e.title}</div>
            <div className="lg:col-span-2 min-w-0 font-mono-x text-xs text-ink-3">{new Date(e.starts_at).toLocaleString("en-GB")}</div>
            <div className="lg:col-span-2 min-w-0 font-mono-x text-xs break-words">{[e.venue, e.city].filter(Boolean).join(", ")}</div>
            <div className={`lg:col-span-1 min-w-0 font-mono-x text-xs ${STATUS_CLASS[eventStatus(e)]}`}>{eventStatus(e)}</div>
            <div className="lg:col-span-3 min-w-0 flex flex-wrap gap-2 lg:justify-end">
              <button onClick={() => setForm(e)} className="btn-primary text-xs">Edit</button>
              <button onClick={() => setNotice({ event: e, kind: "venue" })} data-testid={`notify-btn-${e.event_id}`} className="btn-primary text-xs">Notify</button>
              <button onClick={() => cancel(e)} className="btn-primary text-xs">Cancel</button>
              <button onClick={() => del(e.event_id)} className="btn-primary text-xs">Del</button>
            </div>
          </div>
        ))}
      </div>
      {form && <EventForm form={form} setForm={setForm} onSave={save} onClose={() => setForm(null)} />}
      {notice && <NoticeComposer event={notice.event} initialKind={notice.kind} onClose={() => setNotice(null)} />}
    </div>
  );
}

const NOTICE_KIND_LABELS = {
  venue: "Venue change",
  time: "Time change",
  lineup: "Lineup change",
  cancelled: "Cancelled",
};

// Emails the people holding valid tickets for one event — nobody else. The audience is
// computed server-side from issued tickets; this only shows how many that is, so the
// admin knows the size of what they are about to send before they send it.
function NoticeComposer({ event, initialKind, onClose }) {
  const [kind, setKind] = useState(initialKind || "venue");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState(null);
  const [past, setPast] = useState([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    http.get(`/admin/events/${event.event_id}/notice-preview`).then((r) => setPreview(r.data)).catch(() => setPreview(null));
    http.get(`/admin/events/${event.event_id}/notices`).then((r) => setPast(r.data)).catch(() => setPast([]));
  }, [event.event_id]);

  const count = preview?.recipient_count ?? null;

  const send = async () => {
    if (!message.trim()) return toast.error("Write a message first");
    if (!confirm(`Email ${count ?? "?"} ticket holder${count === 1 ? "" : "s"} about this ${NOTICE_KIND_LABELS[kind].toLowerCase()}?`)) return;
    setSending(true);
    try {
      const r = await http.post(`/admin/events/${event.event_id}/notify`, { kind, message });
      toast.success(`Sent to ${r.data.sent} of ${r.data.recipient_count}${r.data.failed ? ` — ${r.data.failed} failed` : ""}`);
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to send");
    } finally { setSending(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-[rgba(5,5,5,0.9)] flex items-center justify-center p-4">
      <div className="border border-ink/20 bg-surface w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="shrink-0 flex flex-wrap gap-3 justify-between items-center hairline-b px-6 py-4">
          <div className="min-w-0">
            <div className="font-display text-2xl uppercase font-bold truncate">Notify holders</div>
            <div className="font-mono-x text-xs text-ink-4 truncate">{event.title}</div>
          </div>
          <div className="flex gap-2">
            <button onClick={send} disabled={sending || !count} data-testid="send-notice-btn" className="btn-accent disabled:opacity-40">{sending ? "SENDING…" : "SEND"}</button>
            <button onClick={onClose} className="btn-primary">CLOSE</button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
          <div className="font-mono-x text-xs uppercase tracking-[0.2em] text-ink-4">
            {count === null ? "Counting recipients…"
              : count === 0 ? "No ticket holders — nothing to send"
              : `Goes to ${count} ticket holder${count === 1 ? "" : "s"}`}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {Object.entries(NOTICE_KIND_LABELS).map(([k, label]) => (
              <button key={k} onClick={() => setKind(k)} data-testid={`notice-kind-${k}`}
                      className={`px-3 py-2 border font-mono-x text-xs uppercase tracking-[0.2em] ${kind === k ? "bg-ink text-page border-ink" : "border-ink/20 text-ink-2"}`}>{label}</button>
            ))}
          </div>

          <div className="mt-4">
            <Field label="Message to ticket holders">
              <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={6}
                        data-testid="notice-message"
                        placeholder="What changed, and what it means for someone holding a ticket."
                        className="input-x w-full" />
            </Field>
            <div className="mt-1 font-mono-x text-[10px] text-ink-4 uppercase tracking-[0.2em]">
              The event's cover, date, venue and lineup are added automatically.
            </div>
          </div>

          {past.length > 0 && (
            <>
              <div className="mt-8 hairline-b pb-3 font-mono-x uppercase tracking-[0.2em] text-xs text-ink-4">Already sent</div>
              <div className="mt-3 space-y-2">
                {past.map((n) => (
                  <div key={n.notice_id} className="border border-ink/10 p-3">
                    <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4">
                      {NOTICE_KIND_LABELS[n.kind] || n.kind} · {new Date(n.at).toLocaleString("en-GB")} · {n.sent}/{n.recipient_count} delivered
                    </div>
                    <div className="text-sm mt-1 whitespace-pre-wrap break-words">{n.message}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function EventForm({ form, setForm, onSave, onClose }) {
  const setF = (k, v) => setForm({ ...form, [k]: v });
  const setWave = (i, k, v) => { const w = [...form.waves]; w[i] = { ...w[i], [k]: v }; setForm({...form, waves: w}); };
  const descRef = useRef(null);
  return (
    <div className="fixed inset-0 z-50 bg-[rgba(5,5,5,0.9)] flex items-center justify-center p-4">
      {/* Column layout: the action bar stays pinned while only the body scrolls,
          so Save/Close are reachable from anywhere in a long event form. */}
      <div className="border border-ink/20 bg-surface w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="shrink-0 flex flex-wrap gap-3 justify-between items-center hairline-b px-6 py-4">
          <div className="font-display text-2xl uppercase font-bold">{form.event_id ? "Edit" : "New"} Event</div>
          <div className="flex gap-2">
            <button onClick={onSave} data-testid="save-event-btn" className="btn-accent">SAVE</button>
            <button onClick={onClose} data-testid="close-event-btn" className="btn-primary">CLOSE</button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
        <div className="grid grid-cols-2 gap-3">
          <input placeholder="Title" value={form.title} onChange={(e) => setF("title", e.target.value)} className="input-x col-span-2" />
          <input placeholder="Slug" value={form.slug} onChange={(e) => setF("slug", e.target.value)} className="input-x col-span-2" />
          <input placeholder="Venue" value={form.venue} onChange={(e) => setF("venue", e.target.value)} className="input-x" />
          <input placeholder="City" value={form.city || ""} onChange={(e) => setF("city", e.target.value)} className="input-x" />
          <div className="col-span-2">
            <ImageField label="Cover image" value={form.image_url} onChange={(v) => setF("image_url", v)} testId="event-image" />
          </div>
          <div className="col-span-2">
            <FormatToolbar textareaRef={descRef} value={form.description} onChange={(v) => setF("description", v)} />
            <textarea ref={descRef} placeholder="Description" value={form.description} onChange={(e) => setF("description", e.target.value)} className="input-x w-full" rows={3} />
          </div>
          <label className="col-span-1"><div className="text-xs text-ink-4 mb-1 font-mono-x uppercase tracking-[0.2em]">Starts</div><DateTimePicker value={form.starts_at} onChange={(v) => setF("starts_at", v)} /></label>
          <label className="col-span-1"><div className="text-xs text-ink-4 mb-1 font-mono-x uppercase tracking-[0.2em]">Ends</div><DateTimePicker value={form.ends_at} onChange={(v) => setF("ends_at", v)} /></label>
          <label className="col-span-1"><div className="text-xs text-ink-4 mb-1 font-mono-x uppercase tracking-[0.2em]">Doors</div><DateTimePicker value={form.doors_open_at} onChange={(v) => setF("doors_open_at", v)} /></label>
          <label className="col-span-1"><div className="text-xs text-ink-4 mb-1 font-mono-x uppercase tracking-[0.2em]">Max per user</div><input type="number" value={form.max_tickets_per_user} onChange={(e) => setF("max_tickets_per_user", Number(e.target.value))} className="input-x" /></label>
          <label className="col-span-1">
            <div className="text-xs text-ink-4 mb-1 font-mono-x uppercase tracking-[0.2em]">Sold-out message</div>
            <input placeholder="e.g. Sold Out, At the door" value={form.sold_out_message || ""} onChange={(e) => setF("sold_out_message", e.target.value)} className="input-x" />
          </label>
          <label className="col-span-2 flex gap-2 items-center"><input type="checkbox" checked={form.is_published} onChange={(e) => setF("is_published", e.target.checked)} /> <span className="text-sm">Published</span></label>
        </div>
        <div className="mt-8 hairline-b pb-3 flex items-baseline gap-3">
          <div className="font-display text-xl uppercase font-bold">Ticket tiers</div>
          <div className="font-mono-x uppercase tracking-[0.2em] text-[10px] text-ink-4">{form.waves.length} tier{form.waves.length === 1 ? "" : "s"}</div>
        </div>
        <div className="mt-4 space-y-4">
          {form.waves.map((w, i) => (
            <div key={w.wave_id || w._key || `new-${i}`} className="border border-ink/15 bg-ink/[0.02] p-4" data-testid={`wave-row-${i}`}>
              <div className="flex flex-wrap items-center gap-3 pb-3 hairline-b">
                <span className={`shrink-0 px-2 py-1 border font-mono-x uppercase tracking-[0.2em] text-[10px] ${TIER_BADGE[w.tier] || TIER_BADGE.general}`}>
                  {TIER_LABEL[w.tier] || w.tier}
                </span>
                <input placeholder="Tier name" value={w.name} onChange={(e) => setWave(i, "name", e.target.value)} className="input-x flex-1 min-w-[8rem] font-display uppercase font-bold" />
                <select value={w.tier} onChange={(e) => setWave(i, "tier", e.target.value)} className="input-x shrink-0 w-auto">
                  <option value="early_bird">Early Bird</option>
                  <option value="general">General</option>
                  <option value="vip">VIP</option>
                </select>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
                <Field label="Price (RON)"><input type="number" step="0.01" value={w.price_ron} onChange={(e) => setWave(i, "price_ron", Number(e.target.value))} className="input-x w-full" /></Field>
                <Field label="Tickets"><input type="number" value={w.capacity} onChange={(e) => setWave(i, "capacity", Number(e.target.value))} className="input-x w-full" /></Field>
                <Field label="Sale starts"><DateTimePicker value={w.starts_at} onChange={(v) => setWave(i, "starts_at", v)} /></Field>
                <Field label="Sale ends"><DateTimePicker value={w.ends_at} onChange={(v) => setWave(i, "ends_at", v)} /></Field>
                <Field label="Access from" className="col-span-2 md:col-span-1"><DateTimePicker value={w.access_from} onChange={(v) => setWave(i, "access_from", v)} /></Field>
              </div>
            </div>
          ))}
          <button onClick={() => setForm({...form, waves: [...form.waves, { _key: `k-${Date.now()}-${Math.random()}`, name: "NEW", price_ron: 100, capacity: 50, starts_at: new Date().toISOString(), ends_at: new Date(Date.now()+30*864e5).toISOString(), tier: "general", access_from: "" }]})} className="btn-primary">+ Add tier</button>
        </div>
        <div className="mt-6 hairline-b pb-3 font-mono-x uppercase tracking-[0.2em] text-xs text-ink-4">Album</div>
        <div className="mt-3">
          {form.event_id
            ? <EventAlbum eventId={form.event_id} />
            : <div className="text-xs text-ink-4 font-mono-x uppercase tracking-[0.2em]">Save the event once first to upload its album.</div>}
        </div>
        </div>
      </div>
    </div>
  );
}

// The event form and the Gallery tab now drive the same album manager, so
// ordering, cover choice and multi-upload behave identically in both places.
function EventAlbum({ eventId }) {
  return <AlbumManager eventId={eventId} emptyHint="No photos or videos in this event album yet." />;
}

// Two things live under Orders: the purchases (reservations) and the tickets those
// purchases produced. They are different objects with different lifecycles — an order is
// paid or refunded, a ticket is issued, used, denied or refunded — so they get one view
// each rather than one confused list.
function Orders() {
  const [view, setView] = useState("orders");
  return (
    <div>
      <div className="flex flex-wrap gap-2 pb-4 hairline-b">
        {[["orders", "Purchases"], ["tickets", "Tickets"]].map(([k, label]) => (
          <button key={k} onClick={() => setView(k)} data-testid={`orders-view-${k}`}
                  className={`px-3 py-2 border font-mono-x text-xs uppercase tracking-[0.2em] ${view === k ? "bg-ink text-page border-ink" : "border-ink/20 text-ink-2"}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="mt-6">
        {view === "orders" ? <OrderList /> : <TicketList />}
      </div>
    </div>
  );
}

function OrderList() {
  const [orders, setOrders] = useState([]);
  const load = () => http.get("/admin/orders").then((r) => setOrders(r.data));
  useEffect(() => { load(); }, []);
  const refund = async (id) => { if (!confirm("Refund the whole order? Every ticket on it is refunded.")) return; await http.post(`/admin/orders/${id}/refund`); load(); };
  return (
    <div className="space-y-2">
      {orders.map((o) => (
        <div key={o.reservation_id} className="border border-ink/10 bg-surface p-3 grid grid-cols-1 lg:grid-cols-12 gap-3 lg:gap-2 lg:items-center text-sm">
          <div className="lg:col-span-3 min-w-0 font-mono-x text-xs break-words lg:truncate">{o.reservation_id}</div>
          <div className="lg:col-span-2 min-w-0 font-mono-x">{o.total_ron?.toFixed(2)} RON</div>
          <div className="lg:col-span-1 min-w-0">{o.quantity}×</div>
          <div className="lg:col-span-2 min-w-0"><span className="inline-block border border-ink/20 px-2 py-1 font-mono-x text-[10px] uppercase tracking-[0.2em]">{o.status}</span></div>
          <div className="lg:col-span-2 min-w-0 font-mono-x text-xs text-ink-3">{new Date(o.created_at).toLocaleString("en-GB")}</div>
          <div className="lg:col-span-2 min-w-0 lg:text-right">{o.status === "paid" && <button onClick={() => refund(o.reservation_id)} className="btn-primary text-xs">Refund</button>}</div>
        </div>
      ))}
    </div>
  );
}

// The four statuses a ticket can hold, mirroring TICKET_STATUSES in server.py.
const TICKET_FILTERS = [
  ["all", "All"],
  ["issued", "Issued"],
  ["used", "Used"],
  ["denied", "Denied"],
  ["cancelled", "Cancelled"],
  ["refunded", "Refunded"],
];

const TICKET_STATUS_CLASS = {
  issued: "border-ink/20 text-ink-2",
  used: "border-ok/50 text-ok",
  denied: "border-brand/60 text-brand",
  // Solid rather than outlined, and louder than a denial on purpose: one guest refused at
  // the door is a decision, a cancelled show is money the platform owes every holder.
  // (There is no `warn` token in the palette — page/ink/brand/ok/line is the whole set —
  // so this is weight, not a new hue.)
  cancelled: "bg-brand text-brand-fg border-brand",
  refunded: "border-ink/20 text-ink-4",
};

// Every ticket and where it stands. `Denied` is a history filter rather than a status
// filter — a denial that has since been refunded still happened, so it stays listed here
// as well as under Refunded. Filtering it on the current status would hide exactly the
// rows you go looking for after settling up.
function TicketList() {
  const [status, setStatus] = useState("all");
  const [tickets, setTickets] = useState([]);
  const [counts, setCounts] = useState({});
  const [events, setEvents] = useState([]);
  const [eventId, setEventId] = useState("");

  // Bumped after a refund to re-run the fetch. Keeping the request inside the effect
  // rather than calling a `load()` defined outside it is what keeps the dependency list
  // honest — the alternative needs either a useCallback or a lint suppression.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const q = new URLSearchParams();
    if (status !== "all") q.set("status", status);
    if (eventId) q.set("event_id", eventId);
    http.get(`/admin/tickets?${q}`)
      .then((r) => { setTickets(r.data.tickets); setCounts(r.data.counts); })
      .catch(() => { setTickets([]); setCounts({}); });
  }, [status, eventId, reloadKey]);

  useEffect(() => { http.get("/admin/events").then((r) => setEvents(r.data)).catch(() => setEvents([])); }, []);

  const refund = async (t) => {
    const price = Number(t.price_ron || 0).toFixed(2);
    if (!confirm(`Refund this one ticket (${price} RON) to ${t.buyer?.email || "the buyer"}?\n\nThe other tickets on the same order are not affected. Money is returned in the Stripe dashboard.`)) return;
    try {
      await http.post(`/admin/tickets/${t.ticket_id}/refund`);
      toast.success("Ticket marked refunded");
      setReloadKey((k) => k + 1);
    } catch (e) { toast.error(e.response?.data?.detail || "Failed"); }
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2 items-center">
        {TICKET_FILTERS.map(([k, label]) => (
          <button key={k} onClick={() => setStatus(k)} data-testid={`ticket-filter-${k}`}
                  className={`px-3 py-2 border font-mono-x text-xs uppercase tracking-[0.2em] ${status === k ? "bg-ink text-page border-ink" : "border-ink/20 text-ink-2"}`}>
            {label}
            {counts[k] !== undefined && <span className="ml-2 opacity-60">{counts[k]}</span>}
          </button>
        ))}
        <select value={eventId} onChange={(e) => setEventId(e.target.value)}
                data-testid="ticket-event-filter" className="input-x w-auto ml-auto">
          <option value="">All events</option>
          {events.map((e) => <option key={e.event_id} value={e.event_id}>{e.title}</option>)}
        </select>
      </div>

      {tickets.length === 0 ? (
        <div className="mt-6 font-mono-x text-xs uppercase tracking-[0.2em] text-ink-4">No tickets match this filter.</div>
      ) : (
        <div className="mt-4 space-y-2">
          {tickets.map((t) => (
            <div key={t.ticket_id} className="border border-ink/10 bg-surface p-3 grid grid-cols-1 lg:grid-cols-12 gap-3 lg:gap-2 lg:items-center text-sm">
              <div className="lg:col-span-3 min-w-0 font-display font-bold uppercase break-words lg:truncate">{t.event?.title || t.event_id}</div>
              <div className="lg:col-span-3 min-w-0 font-mono-x text-xs break-words lg:truncate">{t.buyer?.email || t.user_id}</div>
              <div className="lg:col-span-2 min-w-0 font-mono-x text-[10px] break-words lg:truncate text-ink-3">{t.qr_code}</div>
              {/* The denial reason is the one thing a status chip cannot carry, so it
                  earns its own column wherever a ticket has one. */}
              <div className="lg:col-span-2 min-w-0 text-xs break-words">
                {t.denied_at ? (t.deny_reason || <span className="text-ink-4">denied · no reason given</span>) : null}
              </div>
              <div className="lg:col-span-2 min-w-0 flex flex-wrap gap-2 lg:justify-end items-center">
                <span className={`inline-block border px-2 py-1 font-mono-x text-[10px] uppercase tracking-[0.2em] ${TICKET_STATUS_CLASS[t.status] || "border-ink/20"}`}>{t.status}</span>
                {t.status !== "refunded" && (
                  <button onClick={() => refund(t)} data-testid={`refund-ticket-${t.ticket_id}`} className="btn-primary text-xs">Refund</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Artists() {
  const [items, setItems] = useState([]);
  const [form, setForm] = useState(null);
  const load = () => http.get("/admin/artists").then((r) => setItems(r.data));
  useEffect(() => { load(); }, []);
  const emptyForm = () => ({ name: "", slug: "", bio: "", image_url: "", links: {} });
  const save = async () => {
    try {
      const links = Object.fromEntries(Object.entries(form.links || {}).filter(([, v]) => v));
      const body = { ...form, links };
      if (form.artist_id) {
        delete body.artist_id; delete body.created_at;
        await http.patch(`/admin/artists/${form.artist_id}`, body);
      } else {
        await http.post("/admin/artists", body);
      }
      setForm(null); load(); toast.success("Saved");
    } catch (e) { toast.error(e.response?.data?.detail || "Failed"); }
  };
  const del = async (id) => { if (!confirm("Delete?")) return; await http.delete(`/admin/artists/${id}`); load(); };
  return (
    <div>
      <button onClick={() => setForm(emptyForm())} className="btn-accent">+ NEW ARTIST</button>
      <div className="mt-6 space-y-2">
        {items.map((a) => (
          <div key={a.artist_id} className="border border-ink/10 p-3 flex justify-between items-center">
            <div className="font-display uppercase">{a.name} · <span className="text-ink-4 text-sm">{a.slug}</span></div>
            <div className="flex gap-2">
              <button onClick={() => setForm({ ...emptyForm(), ...a })} className="btn-primary text-xs">Edit</button>
              <button onClick={() => del(a.artist_id)} className="btn-primary text-xs">Del</button>
            </div>
          </div>
        ))}
      </div>
      {form && <ArtistForm form={form} setForm={setForm} onSave={save} onClose={() => setForm(null)} />}
    </div>
  );
}

function ArtistForm({ form, setForm, onSave, onClose }) {
  const bioRef = useRef(null);
  const setF = (k, v) => setForm({ ...form, [k]: v });
  const setLink = (k, v) => setForm({ ...form, links: { ...(form.links || {}), [k]: v } });
  return (
    <div className="fixed inset-0 z-50 bg-[rgba(5,5,5,0.9)] flex items-center justify-center p-4 overflow-auto">
      <div className="border border-ink/20 bg-surface p-6 w-full max-w-2xl max-h-[90vh] overflow-auto">
        <div className="flex justify-between items-center hairline-b pb-3">
          <div className="font-display text-2xl uppercase font-bold">{form.artist_id ? "Edit" : "New"} Artist</div>
          <button onClick={onClose} className="btn-primary text-xs">Close</button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <input placeholder="Name" value={form.name} onChange={(e) => setF("name", e.target.value)} className="input-x" />
          <input placeholder="Slug" value={form.slug} onChange={(e) => setF("slug", e.target.value)} className="input-x" />
          <input placeholder="Image URL" value={form.image_url} onChange={(e) => setF("image_url", e.target.value)} className="input-x col-span-2" />
          <div className="col-span-2">
            <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 mb-1">Bio</div>
            <FormatToolbar textareaRef={bioRef} value={form.bio} onChange={(v) => setF("bio", v)} />
            <textarea ref={bioRef} placeholder="Bio" value={form.bio} onChange={(e) => setF("bio", e.target.value)} className="input-x w-full" rows={4} />
          </div>
          <div className="col-span-2 mt-2">
            <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 mb-2">Social links (leave blank to hide on the artist's page)</div>
            <div className="grid grid-cols-2 gap-3">
              {SOCIAL_PLATFORMS.map((p) => (
                <input key={p.key} placeholder={`${p.label} URL`} value={form.links?.[p.key] || ""}
                       onChange={(e) => setLink(p.key, e.target.value)} className="input-x" />
              ))}
            </div>
          </div>
        </div>
        <button onClick={onSave} className="btn-accent w-full mt-6">Save</button>
      </div>
    </div>
  );
}

function Projects() {
  const [items, setItems] = useState([]);
  const [f, setF] = useState({ title: "", slug: "", description: "", year: 2024, image_url: "", artist_ids: [], is_past: true });
  const descRef = useRef(null);
  const load = () => http.get("/admin/projects").then((r) => setItems(r.data));
  useEffect(() => { load(); }, []);
  const save = async () => { await http.post("/admin/projects", f); setF({ title: "", slug: "", description: "", year: 2024, image_url: "", artist_ids: [], is_past: true }); load(); };
  const del = async (id) => { await http.delete(`/admin/projects/${id}`); load(); };
  return (
    <div>
      <div className="border border-ink/10 p-4 grid grid-cols-2 gap-3">
        <input placeholder="Title" value={f.title} onChange={(e) => setF({...f, title: e.target.value})} className="input-x" />
        <input placeholder="Slug" value={f.slug} onChange={(e) => setF({...f, slug: e.target.value})} className="input-x" />
        <input type="number" placeholder="Year" value={f.year} onChange={(e) => setF({...f, year: Number(e.target.value)})} className="input-x" />
        <input placeholder="Image URL" value={f.image_url} onChange={(e) => setF({...f, image_url: e.target.value})} className="input-x" />
        <div className="col-span-2">
          <FormatToolbar textareaRef={descRef} value={f.description} onChange={(v) => setF({...f, description: v})} />
          <textarea ref={descRef} placeholder="Description" value={f.description} onChange={(e) => setF({...f, description: e.target.value})} className="input-x w-full" rows={2} />
        </div>
        <button onClick={save} className="btn-accent col-span-2">ADD</button>
      </div>
      <div className="mt-4 space-y-2">
        {items.map((p) => (
          <div key={p.project_id} className="border border-ink/10 p-3 flex justify-between">
            <div className="font-display uppercase">{p.title} · <span className="text-ink-4 text-sm">{p.year}</span></div>
            <button onClick={() => del(p.project_id)} className="btn-primary text-xs">Del</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Discounts() {
  const [items, setItems] = useState([]);
  const [f, setF] = useState({ code: "", percent_off: 10, max_uses: 0, expires_at: "" });
  const load = () => http.get("/admin/discounts").then((r) => setItems(r.data));
  useEffect(() => { load(); }, []);
  const save = async () => { await http.post("/admin/discounts", f); setF({ code: "", percent_off: 10, max_uses: 0, expires_at: "" }); load(); };
  return (
    <div>
      <div className="border border-ink/10 p-4 grid grid-cols-4 gap-3">
        <input placeholder="CODE" value={f.code} onChange={(e) => setF({...f, code: e.target.value.toUpperCase()})} className="input-x uppercase" />
        <input type="number" placeholder="% off" value={f.percent_off} onChange={(e) => setF({...f, percent_off: Number(e.target.value)})} className="input-x" />
        <input type="number" placeholder="Max uses (0=∞)" value={f.max_uses} onChange={(e) => setF({...f, max_uses: Number(e.target.value)})} className="input-x" />
        <input placeholder="Expires ISO" value={f.expires_at} onChange={(e) => setF({...f, expires_at: e.target.value})} className="input-x" />
        <button onClick={save} className="btn-accent col-span-4">ADD</button>
      </div>
      <div className="mt-4 space-y-2">
        {items.map((d) => (
          <div key={d.discount_id} className="border border-ink/10 p-3 flex justify-between font-mono-x text-sm">
            <span>{d.code} · {d.percent_off}%</span>
            <span className="text-ink-4">uses {d.uses}/{d.max_uses || "∞"}</span>
            <button onClick={async () => { await http.delete(`/admin/discounts/${d.discount_id}`); load(); }} className="btn-primary text-xs">Del</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Invites() {
  const [items, setItems] = useState([]);
  const [events, setEvents] = useState([]);
  const [f, setF] = useState({ event_id: "", label: "PRESS", price_ron: 0, capacity: 1 });
  const load = () => { http.get("/admin/special-links").then((r) => setItems(r.data)); http.get("/admin/events").then((r) => setEvents(r.data)); };
  useEffect(() => { load(); }, []);
  const save = async () => { await http.post("/admin/special-links", f); load(); };
  return (
    <div>
      <div className="border border-ink/10 p-4 grid grid-cols-4 gap-3">
        <select value={f.event_id} onChange={(e) => setF({...f, event_id: e.target.value})} className="input-x"><option value="">Event</option>{events.map((e) => <option key={e.event_id} value={e.event_id}>{e.title}</option>)}</select>
        <input placeholder="Label" value={f.label} onChange={(e) => setF({...f, label: e.target.value})} className="input-x" />
        <input type="number" step="0.01" placeholder="Price RON" value={f.price_ron} onChange={(e) => setF({...f, price_ron: Number(e.target.value)})} className="input-x" />
        <input type="number" placeholder="Cap" value={f.capacity} onChange={(e) => setF({...f, capacity: Number(e.target.value)})} className="input-x" />
        <button onClick={save} className="btn-accent col-span-4">ADD</button>
      </div>
      <div className="mt-4 space-y-2">
        {items.map((s) => {
          const ev = events.find((e) => e.event_id === s.event_id);
          const url = ev ? `${window.location.origin}/events/${ev.slug}?invite=${s.token}` : `?invite=${s.token}`;
          return (
            <div key={s.link_id} className="border border-ink/10 p-3 font-mono-x text-xs space-y-1">
              <div className="uppercase tracking-[0.2em] text-ink-4">{s.label} · {s.price_ron.toFixed(2)} RON · {s.used}/{s.capacity} used</div>
              <div className="break-all"><Link to={url.replace(window.location.origin, "")} className="text-ink underline">{url}</Link></div>
              <button onClick={async () => { await http.delete(`/admin/special-links/${s.link_id}`); load(); }} className="btn-primary text-xs mt-1">Del</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Users() {
  const [items, setItems] = useState([]);
  const load = () => http.get("/admin/users").then((r) => setItems(r.data));
  useEffect(() => { load(); }, []);
  const setRole = async (u, role) => {
    if (u.role === role) return; // no-op: already this role
    // Role changes grant/revoke privileges — confirm the exact change first.
    if (!window.confirm(`Change ${u.email || u.name} from "${u.role}" to "${role}"?`)) return;
    try {
      await http.patch(`/admin/users/${u.user_id}/role`, { role });
      toast.success(`${u.email || u.name} is now ${role}`);
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to change role");
    }
  };
  return (
    <div className="space-y-2">
      {items.map((u) => (
        <div key={u.user_id} className="border border-ink/10 p-3 grid grid-cols-1 lg:grid-cols-12 gap-3 lg:gap-2 lg:items-center">
          <div className="lg:col-span-3 min-w-0 break-words">{u.name}</div>
          <div className="lg:col-span-4 min-w-0 text-ink-3 text-sm break-words">{u.email}</div>
          <div className="lg:col-span-1 min-w-0 font-mono-x text-xs uppercase">{u.role}</div>
          {/* Four role buttons need real room — they were sharing two columns. */}
          <div className="lg:col-span-4 min-w-0 flex flex-wrap gap-1 lg:justify-end">
            {["user", "editor", "door", "admin"].map((r) => (
              <button key={r} onClick={() => setRole(u, r)} className={`px-2 py-1 border text-[10px] uppercase tracking-[0.2em] ${u.role===r ? "bg-ink text-page border-ink" : "border-ink/20"}`}>{r}</button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Mirrors the server's _slugify, so the field shows what will actually be stored
// rather than accepting something the API then quietly rewrites.
const slugify = (v) => (v || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Title and slug for the sitewide gallery. The slug is the URL it lives at, so it is
 * shown as one — an editor should be able to see what they are changing. */
function GallerySettings() {
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(false);
  // Left alone once the editor starts typing a slug of their own; until then it tracks
  // the title, which is what people expect from a slug field.
  const [slugTouched, setSlugTouched] = useState(false);

  useEffect(() => {
    http.get("/admin/gallery/settings").then((r) => setSettings(r.data)).catch(() => setSettings(null));
  }, []);

  if (!settings) return null;

  const set = (k, v) => setSettings((s) => ({ ...s, [k]: v }));

  const save = async () => {
    setBusy(true);
    try {
      const { data } = await http.patch("/admin/gallery/settings", {
        title: settings.title,
        slug: settings.slug,
        description: settings.description || "",
      });
      setSettings(data);
      setSlugTouched(false);
      toast.success("Gallery details saved");
    } catch (e) {
      const d = e.response?.data?.detail;
      toast.error(typeof d === "string" ? d : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-ink/10 bg-surface p-4 mb-4" data-testid="gallery-settings">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Gallery title">
          <input
            value={settings.title}
            onChange={(e) => {
              set("title", e.target.value);
              if (!slugTouched) set("slug", slugify(e.target.value));
            }}
            className="input-x w-full"
            data-testid="gallery-title"
          />
        </Field>
        <Field label="Slug">
          <input
            value={settings.slug}
            onChange={(e) => { setSlugTouched(true); set("slug", slugify(e.target.value)); }}
            placeholder="live-documentation"
            className="input-x w-full font-mono-x"
            data-testid="gallery-slug"
          />
        </Field>
      </div>
      <Field label="Intro (optional)" className="mt-3">
        <input value={settings.description || ""} onChange={(e) => set("description", e.target.value)}
               className="input-x w-full" data-testid="gallery-description" />
      </Field>
      <div className="flex flex-wrap items-center gap-3 mt-3">
        <button onClick={save} disabled={busy} className="btn-accent disabled:opacity-40" data-testid="gallery-settings-save">
          {busy ? "…" : "SAVE DETAILS"}
        </button>
        <Link to={`/gallery/${settings.slug}`} className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 hover:text-ink break-all">
          /gallery/{settings.slug} ↗
        </Link>
      </div>
    </div>
  );
}

function GalleryAdmin() {
  const [events, setEvents] = useState([]);
  // "" is the sitewide gallery; any other value is an event album.
  const [albumId, setAlbumId] = useState("");

  useEffect(() => {
    http.get("/admin/events").then((r) => setEvents(r.data)).catch(() => setEvents([]));
  }, []);

  const current = events.find((e) => e.event_id === albumId);

  return (
    <div>
      <div className="border border-ink/10 bg-surface p-4 mb-4">
        <Field label="Album">
          <select value={albumId} onChange={(e) => setAlbumId(e.target.value)} className="input-x w-full" data-testid="gallery-album-select">
            <option value="">Sitewide gallery</option>
            {events.map((e) => <option key={e.event_id} value={e.event_id}>{e.title}</option>)}
          </select>
        </Field>
        <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 mt-2">
          {current
            ? "Shown on this event's page and as its tile on the Gallery page."
            : "Shown directly in the main Gallery grid, alongside event album tiles."}
        </div>
      </div>
      {/* Event albums take their title and slug from the event itself, so this only
          applies to the sitewide one. */}
      {!current && <GallerySettings />}
      {/* Remount on album change so upload queue and drag state never leak across albums. */}
      <AlbumManager
        key={albumId || "sitewide"}
        eventId={albumId || null}
        emptyHint={current ? `No media in "${current.title}" yet.` : "No sitewide gallery items yet."}
      />
    </div>
  );
}

// Mirrors the server's _newsletter_status: rows predating the status field are
// treated as confirmed rather than shown as blank.
const subStatus = (s) => (s.unsubscribed_at ? "unsubscribed" : s.status || "confirmed");
const NEWSLETTER_STATUS_CLASS = {
  confirmed: "text-ok",
  pending: "text-brand",
  unsubscribed: "text-ink-4",
};

function NewsletterAdmin() {
  const [items, setItems] = useState([]);
  const load = () => http.get("/admin/newsletter").then((r) => setItems(r.data));
  useEffect(() => { load(); }, []);
  const del = async (id) => { if (!window.confirm("Remove subscriber?")) return; await http.delete(`/admin/newsletter/${id}`); load(); };
  const csvUrl = `${API}/admin/newsletter.csv`;
  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <div className="font-mono-x text-xs uppercase tracking-[0.2em] text-ink-3">{items.length} subscriber{items.length === 1 ? "" : "s"}</div>
        <a href={csvUrl} className="btn-primary text-xs" data-testid="newsletter-export">Download CSV</a>
      </div>
      <div className="space-y-2">
        {items.map((s) => (
          <div key={s.sub_id} className="border border-ink/10 p-3 grid grid-cols-1 lg:grid-cols-12 gap-3 lg:gap-2 lg:items-center text-sm">
            {/* Addresses have no spaces to wrap at, so they need break-words. */}
            <div className="lg:col-span-4 min-w-0 font-mono-x break-words">{s.email}</div>
            {/* Double opt-in means a row can sit unconfirmed indefinitely; without this
                column an address that never clicked the link looked like a subscriber. */}
            <div className={`lg:col-span-2 min-w-0 font-mono-x text-[10px] uppercase tracking-[0.2em] ${NEWSLETTER_STATUS_CLASS[subStatus(s)]}`}>
              {subStatus(s)}
            </div>
            <div className="lg:col-span-2 min-w-0 text-ink-3 text-xs break-words">{s.source || "—"}</div>
            <div className="lg:col-span-3 min-w-0 font-mono-x text-xs text-ink-3">{new Date(s.created_at).toLocaleString("en-GB")}</div>
            <div className="lg:col-span-1 min-w-0 lg:text-right">
              <button onClick={() => del(s.sub_id)} className="btn-primary text-[10px]" data-testid={`newsletter-del-${s.sub_id}`}>Del</button>
            </div>
          </div>
        ))}
        {items.length === 0 && <div className="text-ink-4 border border-dashed border-ink/10 p-6 text-center font-mono-x text-xs uppercase tracking-[0.3em]">No subscribers yet</div>}
      </div>
    </div>
  );
}

