import React, { useEffect, useRef, useState } from "react";
import { http } from "../api";
import { useAuth } from "../auth";
import { toast } from "sonner";
import { Link } from "react-router-dom";
import { DateTimePicker } from "../components/ui/datetime-picker";
import { FormatToolbar } from "../lib/richText";
import { SOCIAL_PLATFORMS } from "../lib/social";
import { mediaUrl } from "../lib/media";

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

function Stats() {
  const [s, setS] = useState(null);
  useEffect(() => { http.get("/admin/stats").then((r) => setS(r.data)); }, []);
  if (!s) return <div>Loading</div>;
  const cards = [
    ["Revenue", `${s.revenue_ron.toFixed(2)} RON`],
    ["Orders", s.total_orders],
    ["Tickets issued", s.total_tickets],
    ["Scanned", s.scanned],
    ["Events", s.events],
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
      {cards.map(([k, v]) => (
        <div key={k} className="border border-white/10 bg-[#0F0F0F] p-6">
          <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-zinc-500">{k}</div>
          <div className="font-display text-3xl font-black mt-2">{v}</div>
        </div>
      ))}
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

function Events() {
  const [events, setEvents] = useState([]);
  const [form, setForm] = useState(null);
  const load = () => http.get("/admin/events").then((r) => setEvents(r.data));
  useEffect(() => { load(); }, []);
  const emptyForm = () => ({ title: "", slug: "", description: "", venue: "", city: "", starts_at: "", ends_at: "", doors_open_at: "", image_url: "", artist_ids: [], max_tickets_per_user: 4, is_published: true, sold_out_message: "", waves: [{ name: "GENERAL", price_ron: 100, capacity: 100, starts_at: new Date().toISOString(), ends_at: new Date(Date.now()+30*864e5).toISOString(), tier: "general" }] });
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
          <div key={e.event_id} className="border border-white/10 bg-[#0F0F0F] p-4 grid grid-cols-12 gap-2 items-center">
            <div className="col-span-4 font-display font-bold uppercase truncate">{e.title}</div>
            <div className="col-span-3 font-mono-x text-xs text-zinc-400">{new Date(e.starts_at).toLocaleString("en-GB")}</div>
            <div className="col-span-2 font-mono-x text-xs">{[e.venue, e.city].filter(Boolean).join(", ")}</div>
            <div className={`col-span-1 font-mono-x text-xs ${STATUS_CLASS[eventStatus(e)]}`}>{eventStatus(e)}</div>
            <div className="col-span-2 flex gap-2 justify-end">
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
    <div className="fixed inset-0 z-50 bg-[rgba(5,5,5,0.9)] flex items-center justify-center p-4 overflow-auto">
      <div className="border border-white/20 bg-[#0F0F0F] p-6 w-full max-w-3xl max-h-[90vh] overflow-auto">
        <div className="flex justify-between items-center hairline-b pb-3">
          <div className="font-display text-2xl uppercase font-bold">{form.event_id ? "Edit" : "New"} Event</div>
          <button onClick={onClose} className="btn-primary">Close</button>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-4">
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
        <div className="mt-6 hairline-b pb-3 font-mono-x uppercase tracking-[0.2em] text-xs text-zinc-500">Waves</div>
        <div className="mt-3 space-y-2">
          <div className="hidden md:grid grid-cols-12 gap-2 px-3 font-mono-x uppercase tracking-[0.2em] text-[10px] text-zinc-500">
            <div className="col-span-3">Name</div>
            <div className="col-span-2">Price (RON)</div>
            <div className="col-span-2">Tickets (capacity)</div>
            <div className="col-span-2">Sale starts</div>
            <div className="col-span-2">Sale ends</div>
            <div className="col-span-1">Tier</div>
          </div>
          {form.waves.map((w, i) => (
            <div key={w.wave_id || w._key || `new-${i}`} className="grid grid-cols-12 gap-2 border border-white/10 p-3">
              <input placeholder="Name" value={w.name} onChange={(e) => setWave(i, "name", e.target.value)} className="input-x col-span-3 min-w-0" />
              <input type="number" step="0.01" placeholder="Price RON" value={w.price_ron} onChange={(e) => setWave(i, "price_ron", Number(e.target.value))} className="input-x col-span-2 min-w-0" />
              <input type="number" placeholder="Tickets" value={w.capacity} onChange={(e) => setWave(i, "capacity", Number(e.target.value))} className="input-x col-span-2 min-w-0" />
              <div className="col-span-2 min-w-0"><DateTimePicker value={w.starts_at} onChange={(v) => setWave(i, "starts_at", v)} /></div>
              <div className="col-span-2 min-w-0"><DateTimePicker value={w.ends_at} onChange={(v) => setWave(i, "ends_at", v)} /></div>
              <select value={w.tier} onChange={(e) => setWave(i, "tier", e.target.value)} className="input-x col-span-1 min-w-0"><option value="early_bird">early</option><option value="general">gen</option><option value="vip">vip</option></select>
            </div>
          ))}
          <button onClick={() => setForm({...form, waves: [...form.waves, { _key: `k-${Date.now()}-${Math.random()}`, name: "NEW", price_ron: 100, capacity: 50, starts_at: new Date().toISOString(), ends_at: new Date(Date.now()+30*864e5).toISOString(), tier: "general" }]})} className="btn-primary">+ Add wave</button>
        </div>
        <div className="mt-6 hairline-b pb-3 font-mono-x uppercase tracking-[0.2em] text-xs text-zinc-500">Album</div>
        <div className="mt-3">
          {form.event_id
            ? <EventAlbum eventId={form.event_id} />
            : <div className="text-xs text-zinc-500 font-mono-x uppercase tracking-[0.2em]">Save the event once first to upload its album.</div>}
        </div>
        <button onClick={onSave} data-testid="save-event-btn" className="btn-accent w-full mt-6">SAVE</button>
      </div>
    </div>
  );
}

function EventAlbum({ eventId }) {
  const [items, setItems] = useState([]);
  const [uploading, setUploading] = useState(false);
  const load = () => http.get(`/admin/gallery?event_id=${eventId}`).then((r) => setItems(r.data));
  useEffect(() => { load(); }, [eventId]);

  const upload = async (files) => {
    setUploading(true);
    try {
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file);
        const { data } = await http.post("/admin/uploads", fd);
        await http.post("/admin/gallery", {
          image_url: data.url, thumbnail_url: data.thumbnail_url, media_type: data.media_type, event_id: eventId,
        });
      }
      await load();
      toast.success("Uploaded");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const del = async (id) => { await http.delete(`/admin/gallery/${id}`); load(); };

  return (
    <div>
      <label className="btn-primary inline-flex items-center gap-2 cursor-pointer !text-xs">
        {uploading ? "UPLOADING…" : "+ UPLOAD PHOTOS / VIDEO"}
        <input type="file" accept="image/*,video/*" multiple className="hidden" data-testid="album-upload-input"
               onChange={(e) => { if (e.target.files.length) upload([...e.target.files]); e.target.value = ""; }} />
      </label>
      {items.length > 0 && (
        <div className="mt-3 grid grid-cols-4 md:grid-cols-6 gap-2">
          {items.map((g) => (
            <div key={g.gallery_id} className="relative group border border-white/10">
              {g.media_type === "video"
                ? <video src={mediaUrl(g.image_url)} className="w-full aspect-square object-cover" muted />
                : <img src={mediaUrl(g.thumbnail_url || g.image_url)} alt="" className="w-full aspect-square object-cover" />}
              <button onClick={() => del(g.gallery_id)}
                      className="absolute inset-0 bg-black/70 text-white text-xs font-mono-x uppercase tracking-[0.2em] opacity-0 group-hover:opacity-100 transition-opacity">
                Del
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Orders() {
  const [orders, setOrders] = useState([]);
  const load = () => http.get("/admin/orders").then((r) => setOrders(r.data));
  useEffect(() => { load(); }, []);
  const refund = async (id) => { if (!confirm("Refund?")) return; await http.post(`/admin/orders/${id}/refund`); load(); };
  return (
    <div className="space-y-2">
      {orders.map((o) => (
        <div key={o.reservation_id} className="border border-white/10 bg-[#0F0F0F] p-3 grid grid-cols-12 gap-2 text-sm">
          <div className="col-span-3 font-mono-x text-xs truncate">{o.reservation_id}</div>
          <div className="col-span-2 font-mono-x">{o.total_ron?.toFixed(2)} RON</div>
          <div className="col-span-1">{o.quantity}×</div>
          <div className="col-span-2"><span className="border border-white/20 px-2 py-1 font-mono-x text-[10px] uppercase tracking-[0.2em]">{o.status}</span></div>
          <div className="col-span-2 font-mono-x text-xs text-zinc-400">{new Date(o.created_at).toLocaleString("en-GB")}</div>
          <div className="col-span-2 text-right">{o.status === "paid" && <button onClick={() => refund(o.reservation_id)} className="btn-primary text-xs">Refund</button>}</div>
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
        <div key={u.user_id} className="border border-white/10 p-3 grid grid-cols-12 gap-2 items-center">
          <div className="col-span-4">{u.name}</div>
          <div className="col-span-4 text-zinc-400 text-sm">{u.email}</div>
          <div className="col-span-2 font-mono-x text-xs uppercase">{u.role}</div>
          <div className="col-span-2 flex gap-1 justify-end">
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
  const [items, setItems] = useState([]);
  const [caption, setCaption] = useState("");
  const [uploading, setUploading] = useState(false);
  const load = () => http.get("/admin/gallery").then((r) => setItems(r.data));
  useEffect(() => { load(); }, []);

  const upload = async (files) => {
    setUploading(true);
    try {
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file);
        const { data } = await http.post("/admin/uploads", fd);
        await http.post("/admin/gallery", { image_url: data.url, thumbnail_url: data.thumbnail_url, media_type: data.media_type, caption });
      }
      setCaption("");
      await load();
      toast.success("Uploaded");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <div className="border border-white/10 p-4 grid grid-cols-2 gap-3">
        <input placeholder="Caption (applies to next upload)" value={caption} onChange={(e) => setCaption(e.target.value)} className="input-x col-span-2" />
        <label className="btn-accent col-span-2 text-center cursor-pointer">
          {uploading ? "UPLOADING…" : "+ UPLOAD PHOTOS / VIDEO"}
          <input type="file" accept="image/*,video/*" multiple className="hidden" data-testid="sitewide-gallery-upload-input"
                 onChange={(e) => { if (e.target.files.length) upload([...e.target.files]); e.target.value = ""; }} />
        </label>
      </div>
      <div className="mt-4 grid grid-cols-3 md:grid-cols-6 gap-2">
        {items.map((g) => (
          <div key={g.gallery_id} className="border border-white/10">
            {g.media_type === "video"
              ? <video src={mediaUrl(g.image_url)} className="w-full aspect-square object-cover" muted />
              : <img src={mediaUrl(g.thumbnail_url || g.image_url)} alt={g.caption} className="w-full aspect-square object-cover" />}
            <button onClick={async () => { await http.delete(`/admin/gallery/${g.gallery_id}`); load(); }} className="btn-primary text-[10px] w-full">Del</button>
          </div>
        ))}
      </div>
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
          <div key={s.sub_id} className="border border-white/10 p-3 grid grid-cols-12 gap-2 items-center text-sm">
            <div className="col-span-5 font-mono-x">{s.email}</div>
            <div className="col-span-3 text-zinc-400 text-xs">{s.source || "—"}</div>
            <div className="col-span-3 font-mono-x text-xs text-zinc-400">{new Date(s.created_at).toLocaleString("en-GB")}</div>
            <div className="col-span-1 text-right">
              <button onClick={() => del(s.sub_id)} className="btn-primary text-[10px]" data-testid={`newsletter-del-${s.sub_id}`}>Del</button>
            </div>
          </div>
        ))}
        {items.length === 0 && <div className="text-zinc-500 border border-dashed border-white/10 p-6 text-center font-mono-x text-xs uppercase tracking-[0.3em]">No subscribers yet</div>}
      </div>
    </div>
  );
}

