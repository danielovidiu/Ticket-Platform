import React, { useEffect, useRef, useState } from "react";
import { http } from "../api";
import { useAuth } from "../auth";
import { toast } from "sonner";
import { Link } from "react-router-dom";
import { DateTimePicker } from "../components/ui/datetime-picker";
import { FormatToolbar } from "../lib/richText";
import { SOCIAL_PLATFORMS } from "../lib/social";
import AlbumManager from "../components/AlbumManager";

const TABS = ["stats", "events", "orders", "artists", "projects", "discounts", "invites", "users", "gallery", "newsletter"];

export default function Admin() {
  const { user, loading } = useAuth();
  const [tab, setTab] = useState("stats");

  if (loading) return <div className="p-16 text-center font-mono-x text-zinc-500">Loading…</div>;
  if (!user || user.role !== "admin") return <div className="p-16 text-center font-mono-x">Access denied. Admin only.</div>;

  return (
    <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-10">
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">Backstage</div>
      <h1 className="font-display text-4xl md:text-6xl uppercase font-black tracking-tighter mt-2">Admin</h1>
      <div className="mt-6 flex flex-wrap gap-2 hairline-b pb-4">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} data-testid={`admin-tab-${t}`}
                  className={`px-3 py-2 border font-mono-x text-xs uppercase tracking-[0.2em] ${tab===t ? "bg-white text-black border-white" : "border-white/20 text-zinc-300"}`}>{t}</button>
        ))}
      </div>
      <div className="mt-8">
        {tab === "stats" && <Stats />}
        {tab === "events" && <Events />}
        {tab === "orders" && <Orders />}
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
      <div className="border border-white/10 bg-[#0F0F0F] p-4 mb-4" data-testid="stats-filters">
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
          <span className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-zinc-500 ml-auto">
            {filtered ? "Filtered" : "All time · all events"}
          </span>
        </div>
      </div>
      {!s ? <div>Loading</div> : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          {cards.map(([k, v]) => (
            <div key={k} className="border border-white/10 bg-[#0F0F0F] p-4 lg:p-6 min-w-0">
              <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-zinc-500 break-words">{k}</div>
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
  LIVE: "text-[color:var(--success)]",
  PAST: "text-zinc-500",
  DRAFT: "text-[color:var(--accent)]",
};

// Ticket tiers read as full words in the admin form — the abbreviated values
// ("gen", "early") are storage detail, not something an editor should decode.
const TIER_LABEL = { early_bird: "Early Bird", general: "General", vip: "VIP" };
const TIER_BADGE = {
  early_bird: "border-[color:var(--success)] text-[color:var(--success)]",
  general: "border-white/50 text-white",
  vip: "border-[color:var(--accent)] text-[color:var(--accent)]",
};

// Small labelled wrapper so every field in the tier card says what it is.
function Field({ label, className = "", children }) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <div className="text-[10px] text-zinc-500 mb-1 font-mono-x uppercase tracking-[0.2em]">{label}</div>
      {children}
    </label>
  );
}

function Events() {
  const [events, setEvents] = useState([]);
  const [form, setForm] = useState(null);
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
  const cancel = async (id) => { if (!confirm("Cancel event? All tickets refunded.")) return; await http.post(`/admin/events/${id}/cancel`); load(); };

  return (
    <div>
      <button onClick={() => setForm(emptyForm())} data-testid="new-event-btn" className="btn-accent">+ NEW EVENT</button>
      <div className="mt-6 space-y-2">
        {events.map((e) => (
          // Stacked rows on narrow screens; the dense 12-column layout only kicks
          // in at lg, where there is actually room for five columns of text.
          // `min-w-0` lets each cell shrink below its content width, without which
          // grid children refuse to shrink and spill over their neighbours.
          <div key={e.event_id} className="border border-white/10 bg-[#0F0F0F] p-4 grid grid-cols-1 lg:grid-cols-12 gap-3 lg:gap-2 lg:items-center">
            <div className="lg:col-span-4 min-w-0 font-display font-bold uppercase break-words lg:truncate">{e.title}</div>
            <div className="lg:col-span-2 min-w-0 font-mono-x text-xs text-zinc-400">{new Date(e.starts_at).toLocaleString("en-GB")}</div>
            <div className="lg:col-span-2 min-w-0 font-mono-x text-xs break-words">{[e.venue, e.city].filter(Boolean).join(", ")}</div>
            <div className={`lg:col-span-1 min-w-0 font-mono-x text-xs ${STATUS_CLASS[eventStatus(e)]}`}>{eventStatus(e)}</div>
            <div className="lg:col-span-3 min-w-0 flex flex-wrap gap-2 lg:justify-end">
              <button onClick={() => setForm(e)} className="btn-primary text-xs">Edit</button>
              <button onClick={() => cancel(e.event_id)} className="btn-primary text-xs">Cancel</button>
              <button onClick={() => del(e.event_id)} className="btn-primary text-xs">Del</button>
            </div>
          </div>
        ))}
      </div>
      {form && <EventForm form={form} setForm={setForm} onSave={save} onClose={() => setForm(null)} />}
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
      <div className="border border-white/20 bg-[#0F0F0F] w-full max-w-3xl max-h-[90vh] flex flex-col">
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
          <input placeholder="Image URL" value={form.image_url} onChange={(e) => setF("image_url", e.target.value)} className="input-x col-span-2" />
          <div className="col-span-2">
            <FormatToolbar textareaRef={descRef} value={form.description} onChange={(v) => setF("description", v)} />
            <textarea ref={descRef} placeholder="Description" value={form.description} onChange={(e) => setF("description", e.target.value)} className="input-x w-full" rows={3} />
          </div>
          <label className="col-span-1"><div className="text-xs text-zinc-500 mb-1 font-mono-x uppercase tracking-[0.2em]">Starts</div><DateTimePicker value={form.starts_at} onChange={(v) => setF("starts_at", v)} /></label>
          <label className="col-span-1"><div className="text-xs text-zinc-500 mb-1 font-mono-x uppercase tracking-[0.2em]">Ends</div><DateTimePicker value={form.ends_at} onChange={(v) => setF("ends_at", v)} /></label>
          <label className="col-span-1"><div className="text-xs text-zinc-500 mb-1 font-mono-x uppercase tracking-[0.2em]">Doors</div><DateTimePicker value={form.doors_open_at} onChange={(v) => setF("doors_open_at", v)} /></label>
          <label className="col-span-1"><div className="text-xs text-zinc-500 mb-1 font-mono-x uppercase tracking-[0.2em]">Max per user</div><input type="number" value={form.max_tickets_per_user} onChange={(e) => setF("max_tickets_per_user", Number(e.target.value))} className="input-x" /></label>
          <label className="col-span-1">
            <div className="text-xs text-zinc-500 mb-1 font-mono-x uppercase tracking-[0.2em]">Sold-out message</div>
            <input placeholder="e.g. Sold Out, At the door" value={form.sold_out_message || ""} onChange={(e) => setF("sold_out_message", e.target.value)} className="input-x" />
          </label>
          <label className="col-span-2 flex gap-2 items-center"><input type="checkbox" checked={form.is_published} onChange={(e) => setF("is_published", e.target.checked)} /> <span className="text-sm">Published</span></label>
        </div>
        <div className="mt-8 hairline-b pb-3 flex items-baseline gap-3">
          <div className="font-display text-xl uppercase font-bold">Ticket tiers</div>
          <div className="font-mono-x uppercase tracking-[0.2em] text-[10px] text-zinc-500">{form.waves.length} tier{form.waves.length === 1 ? "" : "s"}</div>
        </div>
        <div className="mt-4 space-y-4">
          {form.waves.map((w, i) => (
            <div key={w.wave_id || w._key || `new-${i}`} className="border border-white/15 bg-white/[0.02] p-4" data-testid={`wave-row-${i}`}>
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
        <div className="mt-6 hairline-b pb-3 font-mono-x uppercase tracking-[0.2em] text-xs text-zinc-500">Album</div>
        <div className="mt-3">
          {form.event_id
            ? <EventAlbum eventId={form.event_id} />
            : <div className="text-xs text-zinc-500 font-mono-x uppercase tracking-[0.2em]">Save the event once first to upload its album.</div>}
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

function Orders() {
  const [orders, setOrders] = useState([]);
  const load = () => http.get("/admin/orders").then((r) => setOrders(r.data));
  useEffect(() => { load(); }, []);
  const refund = async (id) => { if (!confirm("Refund?")) return; await http.post(`/admin/orders/${id}/refund`); load(); };
  return (
    <div className="space-y-2">
      {orders.map((o) => (
        <div key={o.reservation_id} className="border border-white/10 bg-[#0F0F0F] p-3 grid grid-cols-1 lg:grid-cols-12 gap-3 lg:gap-2 lg:items-center text-sm">
          <div className="lg:col-span-3 min-w-0 font-mono-x text-xs break-words lg:truncate">{o.reservation_id}</div>
          <div className="lg:col-span-2 min-w-0 font-mono-x">{o.total_ron?.toFixed(2)} RON</div>
          <div className="lg:col-span-1 min-w-0">{o.quantity}×</div>
          <div className="lg:col-span-2 min-w-0"><span className="inline-block border border-white/20 px-2 py-1 font-mono-x text-[10px] uppercase tracking-[0.2em]">{o.status}</span></div>
          <div className="lg:col-span-2 min-w-0 font-mono-x text-xs text-zinc-400">{new Date(o.created_at).toLocaleString("en-GB")}</div>
          <div className="lg:col-span-2 min-w-0 lg:text-right">{o.status === "paid" && <button onClick={() => refund(o.reservation_id)} className="btn-primary text-xs">Refund</button>}</div>
        </div>
      ))}
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
          <div key={a.artist_id} className="border border-white/10 p-3 flex justify-between items-center">
            <div className="font-display uppercase">{a.name} · <span className="text-zinc-500 text-sm">{a.slug}</span></div>
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
      <div className="border border-white/20 bg-[#0F0F0F] p-6 w-full max-w-2xl max-h-[90vh] overflow-auto">
        <div className="flex justify-between items-center hairline-b pb-3">
          <div className="font-display text-2xl uppercase font-bold">{form.artist_id ? "Edit" : "New"} Artist</div>
          <button onClick={onClose} className="btn-primary text-xs">Close</button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <input placeholder="Name" value={form.name} onChange={(e) => setF("name", e.target.value)} className="input-x" />
          <input placeholder="Slug" value={form.slug} onChange={(e) => setF("slug", e.target.value)} className="input-x" />
          <input placeholder="Image URL" value={form.image_url} onChange={(e) => setF("image_url", e.target.value)} className="input-x col-span-2" />
          <div className="col-span-2">
            <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-zinc-500 mb-1">Bio</div>
            <FormatToolbar textareaRef={bioRef} value={form.bio} onChange={(v) => setF("bio", v)} />
            <textarea ref={bioRef} placeholder="Bio" value={form.bio} onChange={(e) => setF("bio", e.target.value)} className="input-x w-full" rows={4} />
          </div>
          <div className="col-span-2 mt-2">
            <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-zinc-500 mb-2">Social links (leave blank to hide on the artist's page)</div>
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
      <div className="border border-white/10 p-4 grid grid-cols-2 gap-3">
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
          <div key={p.project_id} className="border border-white/10 p-3 flex justify-between">
            <div className="font-display uppercase">{p.title} · <span className="text-zinc-500 text-sm">{p.year}</span></div>
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
      <div className="border border-white/10 p-4 grid grid-cols-4 gap-3">
        <input placeholder="CODE" value={f.code} onChange={(e) => setF({...f, code: e.target.value.toUpperCase()})} className="input-x uppercase" />
        <input type="number" placeholder="% off" value={f.percent_off} onChange={(e) => setF({...f, percent_off: Number(e.target.value)})} className="input-x" />
        <input type="number" placeholder="Max uses (0=∞)" value={f.max_uses} onChange={(e) => setF({...f, max_uses: Number(e.target.value)})} className="input-x" />
        <input placeholder="Expires ISO" value={f.expires_at} onChange={(e) => setF({...f, expires_at: e.target.value})} className="input-x" />
        <button onClick={save} className="btn-accent col-span-4">ADD</button>
      </div>
      <div className="mt-4 space-y-2">
        {items.map((d) => (
          <div key={d.discount_id} className="border border-white/10 p-3 flex justify-between font-mono-x text-sm">
            <span>{d.code} · {d.percent_off}%</span>
            <span className="text-zinc-500">uses {d.uses}/{d.max_uses || "∞"}</span>
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
      <div className="border border-white/10 p-4 grid grid-cols-4 gap-3">
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
            <div key={s.link_id} className="border border-white/10 p-3 font-mono-x text-xs space-y-1">
              <div className="uppercase tracking-[0.2em] text-zinc-500">{s.label} · {s.price_ron.toFixed(2)} RON · {s.used}/{s.capacity} used</div>
              <div className="break-all"><Link to={url.replace(window.location.origin, "")} className="text-white underline">{url}</Link></div>
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
        <div key={u.user_id} className="border border-white/10 p-3 grid grid-cols-1 lg:grid-cols-12 gap-3 lg:gap-2 lg:items-center">
          <div className="lg:col-span-3 min-w-0 break-words">{u.name}</div>
          <div className="lg:col-span-4 min-w-0 text-zinc-400 text-sm break-words">{u.email}</div>
          <div className="lg:col-span-1 min-w-0 font-mono-x text-xs uppercase">{u.role}</div>
          {/* Four role buttons need real room — they were sharing two columns. */}
          <div className="lg:col-span-4 min-w-0 flex flex-wrap gap-1 lg:justify-end">
            {["user", "editor", "door", "admin"].map((r) => (
              <button key={r} onClick={() => setRole(u, r)} className={`px-2 py-1 border text-[10px] uppercase tracking-[0.2em] ${u.role===r ? "bg-white text-black border-white" : "border-white/20"}`}>{r}</button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function GalleryAdmin() {
  const [events, setEvents] = useState([]);
  // "" is the sitewide Documentation gallery; any other value is an event album.
  const [albumId, setAlbumId] = useState("");

  useEffect(() => {
    http.get("/admin/events").then((r) => setEvents(r.data)).catch(() => setEvents([]));
  }, []);

  const current = events.find((e) => e.event_id === albumId);

  return (
    <div>
      <div className="border border-white/10 bg-[#0F0F0F] p-4 mb-4">
        <Field label="Album">
          <select value={albumId} onChange={(e) => setAlbumId(e.target.value)} className="input-x w-full" data-testid="gallery-album-select">
            <option value="">Sitewide gallery (Documentation)</option>
            {events.map((e) => <option key={e.event_id} value={e.event_id}>{e.title}</option>)}
          </select>
        </Field>
        <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-zinc-500 mt-2">
          {current
            ? "Shown on this event's page and as its tile on the Gallery page."
            : "Shown directly in the main Gallery grid, alongside event album tiles."}
        </div>
      </div>
      {/* Remount on album change so upload queue and drag state never leak across albums. */}
      <AlbumManager
        key={albumId || "sitewide"}
        eventId={albumId || null}
        emptyHint={current ? `No media in "${current.title}" yet.` : "No sitewide gallery items yet."}
      />
    </div>
  );
}

function NewsletterAdmin() {
  const [items, setItems] = useState([]);
  const load = () => http.get("/admin/newsletter").then((r) => setItems(r.data));
  useEffect(() => { load(); }, []);
  const del = async (id) => { if (!window.confirm("Remove subscriber?")) return; await http.delete(`/admin/newsletter/${id}`); load(); };
  const csvUrl = `${process.env.REACT_APP_BACKEND_URL}/api/admin/newsletter.csv`;
  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <div className="font-mono-x text-xs uppercase tracking-[0.2em] text-zinc-400">{items.length} subscriber{items.length === 1 ? "" : "s"}</div>
        <a href={csvUrl} className="btn-primary text-xs" data-testid="newsletter-export">Download CSV</a>
      </div>
      <div className="space-y-2">
        {items.map((s) => (
          <div key={s.sub_id} className="border border-white/10 p-3 grid grid-cols-1 lg:grid-cols-12 gap-3 lg:gap-2 lg:items-center text-sm">
            {/* Addresses have no spaces to wrap at, so they need break-words. */}
            <div className="lg:col-span-5 min-w-0 font-mono-x break-words">{s.email}</div>
            <div className="lg:col-span-2 min-w-0 text-zinc-400 text-xs break-words">{s.source || "—"}</div>
            <div className="lg:col-span-3 min-w-0 font-mono-x text-xs text-zinc-400">{new Date(s.created_at).toLocaleString("en-GB")}</div>
            <div className="lg:col-span-2 min-w-0 lg:text-right">
              <button onClick={() => del(s.sub_id)} className="btn-primary text-[10px]" data-testid={`newsletter-del-${s.sub_id}`}>Del</button>
            </div>
          </div>
        ))}
        {items.length === 0 && <div className="text-zinc-500 border border-dashed border-white/10 p-6 text-center font-mono-x text-xs uppercase tracking-[0.3em]">No subscribers yet</div>}
      </div>
    </div>
  );
}

