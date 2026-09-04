import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { http, API } from "../api";
import { money, ron } from "../lib/money";
import { useAuth } from "../auth";
import { toast } from "sonner";
import { Link } from "react-router-dom";
import { DateTimePicker } from "../components/ui/datetime-picker";
import { nextMorningAt6, doorsFrom, dayBefore, isPast } from "../lib/eventDates";
import { FormatToolbar } from "../lib/richText";
import { SOCIAL_PLATFORMS } from "../lib/social";
import AlbumManager from "../components/AlbumManager";
import ImageField from "../components/ImageField";
import PosterField from "../components/PosterField";
import { ShopProducts, ShopOrders, ShopSettings } from "../components/ShopAdmin";
import { eventStatus, STATUS_CLASS, TICKET_FILTERS, TICKET_STATUS_CLASS } from "../lib/ticketStatus";

const TABS = ["stats", "events", "orders", "transactions", "shop", "shop orders", "shop settings",
              "artists", "discounts", "invites", "users", "gallery", "newsletter"];

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
        {tab === "transactions" && <Transactions />}
        {tab === "shop" && <ShopProducts />}
        {tab === "shop orders" && <ShopOrders />}
        {tab === "shop settings" && <ShopSettings />}
        {tab === "artists" && <Artists />}
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

/**
 * The filter set shared by Stats and Transactions.
 *
 * They have to agree: a figure checked on the stats cards is the figure someone then
 * exports and declares, and two screens that filter "the same" rows by slightly
 * different rules is how a fiscal return ends up wrong. One hook, one query string.
 */
const TICKET_STATUS_OPTIONS = ["issued", "used", "denied", "cancelled", "refunded"];

function useSalesFilters() {
  const [events, setEvents] = useState([]);
  // Both are sets of choices, not single ones: "how did these three events do" and "issued
  // plus used" are the questions people actually arrive with, and answering them one
  // value at a time means reading four screens and adding up by hand.
  const [eventIds, setEventIds] = useState([]);
  const [statuses, setStatuses] = useState([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  useEffect(() => { http.get("/admin/events").then((r) => setEvents(r.data)).catch(() => setEvents([])); }, []);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    // One comma-separated parameter rather than a repeated key, so the URL stays
    // readable when someone reproduces a figure by hand.
    if (eventIds.length) p.set("event_id", eventIds.join(","));
    if (dateFrom) p.set("date_from", dateFrom);
    if (dateTo) p.set("date_to", dateTo);
    if (statuses.length) p.set("status", statuses.join(","));
    return p.toString();
  }, [eventIds, dateFrom, dateTo, statuses]);

  const setLastDays = (n) => {
    const to = new Date();
    setDateFrom(isoDay(new Date(to.getTime() - n * 864e5)));
    setDateTo(isoDay(to));
  };
  const clear = () => { setEventIds([]); setDateFrom(""); setDateTo(""); setStatuses([]); };

  return { events, eventIds, setEventIds, dateFrom, setDateFrom, dateTo, setDateTo,
           statuses, setStatuses, query, setLastDays, clear,
           filtered: !!(eventIds.length || dateFrom || dateTo || statuses.length) };
}

/**
 * A dropdown that takes several answers.
 *
 * Not a native `<select multiple>`: that renders as a fixed-height scrolling box, needs
 * ctrl-click to add a second value, and silently drops the whole selection on a stray
 * plain click — which for a filter feeding a fiscal export is the wrong kind of easy to
 * get wrong. This closes over its own summary line and every option is a checkbox, so
 * adding a fourth event cannot clear the first three.
 */
function MultiSelect({ label, options, selected, onChange, allLabel, testId }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Functional update, not `[...selected, value]`. Two ticks in quick succession both
  // read the `selected` captured at render, so computing from it drops the first one —
  // which is exactly what "multi-select" must not do.
  const toggle = (value) => {
    onChange((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  };

  const summary = selected.length === 0
    ? allLabel
    : selected.length === 1
      ? (options.find((o) => o.value === selected[0])?.label || selected[0])
      : `${selected.length} selected`;

  return (
    <div className="relative min-w-0" ref={ref}>
      <div className="text-[10px] text-ink-4 mb-1 font-mono-x uppercase tracking-[0.2em]">{label}</div>
      <button type="button" onClick={() => setOpen((o) => !o)} data-testid={testId}
              className="input-x w-full flex items-center justify-between gap-2 text-left min-w-0">
        <span className={`truncate ${selected.length ? "" : "text-ink-4"}`}>{summary}</span>
        <span className="text-ink-4 shrink-0 text-[10px]">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="absolute z-40 mt-1 w-full max-h-64 overflow-y-auto border border-ink/20 bg-surface shadow-2xl"
             data-testid={`${testId}-menu`}>
          {selected.length > 0 && (
            <button type="button" onClick={() => onChange([])}
                    className="w-full text-left px-3 py-2 font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 hover:text-ink border-b border-ink/10">
              Clear selection
            </button>
          )}
          {options.map((o) => (
            <label key={o.value} className="flex items-center gap-2 px-3 py-2 text-xs cursor-pointer hover:bg-ink/5">
              <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)}
                     data-testid={`${testId}-opt-${o.value}`} />
              <span className="truncate">{o.label}</span>
            </label>
          ))}
          {options.length === 0 && (
            <div className="px-3 py-2 font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-5">Nothing to choose</div>
          )}
        </div>
      )}
    </div>
  );
}

function SalesFilters({ f, testId }) {
  return (
    <div className="border border-ink/10 bg-surface p-4 mb-4" data-testid={testId}>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <MultiSelect
          label="Event" allLabel="All events" testId={`${testId}-event`}
          options={f.events.map((e) => ({ value: e.event_id, label: e.title }))}
          selected={f.eventIds} onChange={f.setEventIds}
        />
        <MultiSelect
          label="Ticket status" allLabel="Any status" testId={`${testId}-status`}
          options={TICKET_STATUS_OPTIONS.map((s) => ({ value: s, label: s }))}
          selected={f.statuses} onChange={f.setStatuses}
        />
        <Field label="From">
          <DateTimePicker mode="date" value={f.dateFrom} placeholder="Any date" onChange={f.setDateFrom} />
        </Field>
        <Field label="To">
          <DateTimePicker mode="date" value={f.dateTo} placeholder="Any date" onChange={f.setDateTo} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2 items-center mt-3">
        {STAT_PRESETS.map(([label, days]) => (
          <button key={label} onClick={() => f.setLastDays(days())} className="btn-primary text-xs">Last {label}</button>
        ))}
        {f.filtered && <button onClick={f.clear} className="btn-primary text-xs" data-testid={`${testId}-clear`}>Clear</button>}
        <span className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 ml-auto">
          {f.filtered ? "Filtered" : "All time · all events"}
        </span>
      </div>
    </div>
  );
}

function Stats() {
  const [s, setS] = useState(null);
  const f = useSalesFilters();
  const { query } = f;

  useEffect(() => {
    http.get(`/admin/stats${query ? `?${query}` : ""}`).then((r) => setS(r.data));
  }, [query]);

  const filtered = f.filtered;
  const cards = s && [
    ["Revenue", ron(s.revenue_ron)],
    ["Orders", s.total_orders],
    ["Tickets issued", s.total_tickets],
    ["Scanned", s.scanned],
    [filtered ? "Events with sales" : "Events", s.events],
  ];

  return (
    <div>
      <SalesFilters f={f} testId="stats-filters" />
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

// Mirrors IMAGE_ASPECTS in server.py and ASPECTS in components/blocks. A value outside
// the map renders as no aspect class at all, which collapses the image to nothing.
const EVENT_IMAGE_ASPECTS = ["1:1", "4:3", "3:4", "16:9", "21:9", "3:2", "16:10"];

/** An event as the form wants it, which is very nearly as the server sends it.
 *
 * The one difference is the poster collection. Every event saved before `images` existed
 * carries a lone `image_url`, and opening one of those in the editor has to show that
 * picture in the strip — otherwise its artwork looks unset, and the first save from a form
 * that never displayed it would write an empty collection over a real one.
 *
 * Reading it forward here rather than migrating the database keeps the rule in one place
 * and leaves stored events alone until someone actually edits them.
 */
function editableEvent(e) {
  const images = Array.isArray(e.images) ? e.images : [];
  const main = (e.image_url || "").trim();
  return { ...e, images: images.length || !main ? images : [main] };
}

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
  const emptyForm = () => ({ title: "", slug: "", description: "", venue: "", city: "", starts_at: "", ends_at: "", doors_open_at: "", image_url: "", images: [], image_aspect: "4:3", artist_ids: [], max_tickets_per_user: 4, is_published: true, sold_out_message: "", waves: [{ tier_id: 1, name: "GENERAL", price_ron: 100, capacity: 100, starts_at: new Date().toISOString(), ends_at: "", access_until: "", access_from: "", status: "active", pack_size: 1, max_tickets_per_user: null, sold_out_message: "" }] });
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
          // Two columns, and the split is deliberate: everything you DO with an event on
          // the left under its name, everything you need to KNOW about how it is selling
          // on the right. The old row put five equal-weight cells in a line, so the title
          // competed with the venue for attention and the sales numbers were not there
          // at all — you had to open the event to find out whether it was selling.
          <div key={e.event_id} className="border border-ink/10 bg-surface p-4 grid grid-cols-1 lg:grid-cols-2 gap-4"
               data-testid={`event-row-${e.event_id}`}>
            <div className="min-w-0">
              <div className="font-display font-bold uppercase break-words text-lg leading-tight">{e.title}</div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4">
                <span>{new Date(e.starts_at).toLocaleString("en-GB")}</span>
                {[e.venue, e.city].filter(Boolean).length > 0 && <span>{[e.venue, e.city].filter(Boolean).join(", ")}</span>}
                <span className={STATUS_CLASS[eventStatus(e)]}>{eventStatus(e)}</span>
                {e.event_code && <span className="text-ink-3" title="Code used in ticket serials">{e.event_code}</span>}
              </div>
              <div className="flex flex-wrap gap-2 mt-3">
                <button onClick={() => setForm(editableEvent(e))} className="btn-primary text-xs">Edit</button>
                <button onClick={() => setNotice({ event: e, kind: "venue" })} data-testid={`notify-btn-${e.event_id}`} className="btn-primary text-xs">Notify</button>
                <button onClick={() => cancel(e)} className="btn-primary text-xs">Cancel</button>
                <button onClick={() => del(e.event_id)} className="btn-primary text-xs">Del</button>
              </div>
            </div>
            <TierSales waves={e.waves} />
          </div>
        ))}
      </div>
      {form && <EventForm form={form} setForm={setForm} onSave={save} onClose={() => setForm(null)} />}
      {notice && <NoticeComposer event={notice.event} initialKind={notice.kind} onClose={() => setNotice(null)} />}
    </div>
  );
}

/** How each tier is selling, per event row.
 *
 * `available` is what the server decrements on every hold, so sold is capacity minus it
 * — the same arithmetic the box office does, rather than a second count that could
 * disagree with it. A tier at zero says SOLD OUT rather than "0 left", because those
 * read very differently at a glance and only one of them is news.
 */
/* Exported for TierSales.test.jsx. Its alignment is structural — one grid, a
   content-sized count column — and that is worth asserting directly. */
export function TierSales({ waves }) {
  const tiers = waves || [];
  if (!tiers.length) {
    return <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-5 lg:text-right">No tiers</div>;
  }
  /* One grid over every tier, not a flex row per tier.
   *
   * Each tier used to be its own flex line, so the three columns only lined up by
   * coincidence — and the count sat in a fixed w-28 that its own content did not fit:
   * "88/100 · 12 left" is eighteen mono characters at 0.15em tracking, which wrapped
   * inside the box and pushed "left" onto a second line. That is what made the rows
   * different heights and the numbers look ragged.
   *
   * A single grid gives all rows the same three columns, and an `auto` last column
   * sizes itself to the widest count across the whole list, so nothing wraps and every
   * row ends on the same edge. The bar column disappears on a phone via `hidden`, which
   * removes it from the grid flow rather than leaving an empty cell behind.
   */
  return (
    <div className="min-w-0 grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_5rem_auto] items-center gap-x-3 gap-y-1.5"
         data-testid="tier-sales">
      {tiers.map((w) => {
        const capacity = w.capacity ?? 0;
        const left = Math.max(0, w.available ?? capacity);
        /* Tickets actually issued, when the server has counted them — which on this
           screen it always has. Capacity-minus-available is the fallback for any caller
           without that count, and it is a DIFFERENT number: it also carries live
           checkout holds and any capacity edit made since the sales. Preferring the real
           count is what keeps this row agreeing with the sold count in the editor, where
           the same number decides whether a tier may be deleted. */
        const sold = w.sold ?? Math.max(0, capacity - left);
        const pct = capacity ? Math.round((sold / capacity) * 100) : 0;
        const state = w.status || "active";
        const pack = Math.max(1, Number(w.pack_size) || 1);
        return (
          <Fragment key={w.wave_id || w.name}>
            <span className={`font-mono-x text-xs uppercase tracking-[0.15em] truncate ${state === "active" ? "text-ink-2" : "text-ink-4"}`}>
              {w.name}
              {/* Both say "not selling", and they say it for different reasons, so both
                  are named rather than collapsed into one greyed-out row. */}
              {state !== "active" && <span className="text-[9px] tracking-[0.2em] ml-1.5">[{state === "archived" ? "arch" : "paused"}]</span>}
              {pack > 1 && <span className="text-[9px] tracking-[0.2em] ml-1.5 text-ink-4">×{pack}</span>}
            </span>
            {/* A bar earns its place here: twelve events in a list is a lot of numbers to
                compare, and relative fill is readable without reading any of them. */}
            <span className="hidden sm:block w-full h-1.5 bg-ink/10" aria-hidden="true">
              <span className="block h-full bg-brand" style={{ width: `${pct}%` }} />
            </span>
            {/* nowrap is the fix; tabular-nums is what keeps the counts in a column
                rather than jittering with the width of each digit. */}
            <span className="font-mono-x text-[10px] uppercase tracking-[0.15em] text-ink-4 whitespace-nowrap tabular-nums text-right">
              {sold}/{capacity} · {left === 0 ? <span className="text-brand">sold out</span> : `${left} left`}
            </span>
          </Fragment>
        );
      })}
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

/* Where a tier stands. Mirrors WAVE_STATUSES in server.py.
 *
 * Three states rather than a checkbox because the two ways of taking a tier off sale are
 * not the same decision. `paused` leaves it on the event page — "VIP, back shortly" —
 * and `archived` takes it off entirely, which is what an editor reaches for when they
 * would otherwise want to delete a tier that has already sold.
 */
const TIER_STATES = [
  { value: "active", label: "On sale", hint: "Listed on the event page and buyable." },
  { value: "paused", label: "Paused", hint: "Still listed, but nobody can buy it." },
  { value: "archived", label: "Archived", hint: "Off the event page. Sold tickets stay valid." },
];

const ron2 = (n) => (Math.round(Number(n || 0) * 100) / 100).toFixed(2);

/** One ticket tier in the event editor.
 *
 * Its own component because the card grew three things a tier row did not used to carry
 * — a state, a pack size, and a count of what it has actually sold — and those three are
 * the ones that talk to each other. The count is what decides whether the delete button
 * exists at all, and the state is what an editor is offered instead when it does not.
 */
export function TierCard({ wave: w, index: i, onField, onFields, onTouchEndsAt, onDelete, eventMaxPerUser }) {
  const status = w.status || "active";
  const sold = Number(w.sold) || 0;
  const held = Number(w.held) || 0;
  /* A tier is deletable only while nothing points at it. `sold` counts every ticket ever
     issued from it, refunded ones included — a refund does not unissue a serial — and
     `held` covers a checkout that is open right now. Both come from the server rather
     than from capacity-minus-available, which is sales AND holds AND any capacity edit
     the promoter has made since, and is no basis for a deletion. */
  const deletable = sold === 0 && held === 0;
  const packSize = Math.max(1, Number(w.pack_size) || 1);
  const isPack = packSize > 1;
  const capacity = Number(w.capacity) || 0;
  /* Capacity counts individual tickets, so a tier selling in fours needs a multiple of
     four; anything else strands a remainder nobody can buy. Flagged here rather than only
     refused on save, so the editor sees it while the number is still under their cursor. */
  const remainder = isPack && capacity ? capacity % packSize : 0;

  return (
    <div className={`border p-4 transition-opacity ${status === "archived"
                       ? "border-dashed border-ink/25 bg-ink/[0.01] opacity-60"
                       : "border-ink/15 bg-ink/[0.02]"}`}
         data-testid={`wave-row-${i}`} data-status={status}>
      {/* What this tier has actually done, and what may be done to it, above the fields
          and out of the way: it is the card's status line, not one of its inputs. The
          count and the delete affordance stay on one line because the first is the reason
          for the second — an editor reaching for Delete on a tier that has sold needs the
          count in the same glance as the sentence explaining why the button is not there. */}
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 mb-3 text-right font-mono-x text-[10px] uppercase tracking-[0.2em]">
        {status === "archived" && (
          <span className="text-ink-4 normal-case tracking-normal font-sans text-xs"
                data-testid={`wave-archived-note-${i}`}>
            Hidden from buyers. Set it back to On sale at any time.
          </span>
        )}
        {!deletable && (
          <span className="text-ink-4 normal-case tracking-normal font-sans text-xs"
                data-testid={`wave-undeletable-${i}`}>
            {sold > 0
              ? "Sold tickets \u2014 archive it instead. They stay valid, and you can put the tier back."
              : "A checkout is holding tickets from this tier. Archive it, or wait for the hold to lapse."}
          </span>
        )}
        <span className={sold ? "text-ink-2" : "text-ink-4"} data-testid={`wave-sold-${i}`}>
          {sold} sold{held ? ` \u00b7 ${held} held` : ""}
        </span>
        {deletable && (
          <button type="button" onClick={onDelete} data-testid={`wave-delete-${i}`}
                  className="uppercase tracking-[0.2em] text-brand hover:underline">
            Delete tier
          </button>
        )}
      </div>

      {/* What the tier IS, on one line: which one it is, whether it sells, what it is
          called, and what it costs. The id took the badge's place — the badge showed the
          early_bird/general/vip dropdown's value, and that dropdown is gone: it decided
          nothing a buyer could see, while the running order it did not control was the
          thing editors actually wanted to change.

          Widths are set per field rather than by an even split: a tier id is two digits
          and a tier name is a name. Wraps rather than crushes on a narrow dialog.

          Every control here carries the same padding AND the same text size, which is what
          makes them one height. The state select used to be text-xs against the inputs'
          full size, and that alone stood it a few pixels short of its neighbours — the
          kind of difference nobody can name and everybody can see. */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="shrink-0">
          <div className="text-[10px] text-ink-4 mb-1 font-mono-x uppercase tracking-[0.2em]">Tier id</div>
          {/* Sized to a running-order number — two or three digits — rather than to the
              width a text field happens to default to. Centred, because a number in a box
              four times its width reads as a field somebody forgot to fill in. */}
          <input type="number" min="1" step="1" value={w.tier_id ?? ""}
                 onChange={(e) => onField("tier_id", e.target.value === "" ? null : Number(e.target.value))}
                 data-testid={`wave-tier-id-${i}`}
                 className="input-x w-16 px-2 text-center font-mono-x" />
        </label>
        <label className="shrink-0">
          <div className="text-[10px] text-ink-4 mb-1 font-mono-x uppercase tracking-[0.2em]">State</div>
          {/* appearance-none, then our own chevron. A native select sizes itself from the
              platform widget rather than from the padding it is given, so with identical
              classes it still came out a few pixels taller than the inputs either side —
              the kind of difference nobody can name and everybody can see. Stripped of the
              native appearance it is a box with padding, exactly like its neighbours. */}
          <div className="relative">
            <select value={status} onChange={(e) => onField("status", e.target.value)}
                    data-testid={`wave-status-${i}`}
                    title={TIER_STATES.find((s) => s.value === status)?.hint}
                    className="input-x w-36 pr-8 appearance-none font-mono-x uppercase tracking-[0.15em]">
              {TIER_STATES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <span aria-hidden="true"
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-4 font-mono-x text-[10px]">▼</span>
          </div>
        </label>
        <label className="flex-1 min-w-[8rem]">
          <div className="text-[10px] text-ink-4 mb-1 font-mono-x uppercase tracking-[0.2em]">Tier name</div>
          <input placeholder="Tier name" value={w.name} onChange={(e) => onField("name", e.target.value)}
                 data-testid={`wave-name-${i}`}
                 className="input-x w-full font-display uppercase font-bold" />
        </label>
        {/* On a pack tier this is the price of the WHOLE pack, which is what the buyer
            is actually charged and therefore what the promoter should be typing. The
            per-ticket rate underneath is derived, never entered — it is the number the
            refunds are settled on, so it is shown rather than left to be worked out. */}
        <label className="shrink-0 w-28">
          <div className="text-[10px] text-ink-4 mb-1 font-mono-x uppercase tracking-[0.2em]">{isPack ? `Price for ${packSize} (RON)` : "Price (RON)"}</div>
          <input type="number" step="0.01" value={w.price_ron}
                 onChange={(e) => onField("price_ron", Number(e.target.value))}
                 data-testid={`wave-price-${i}`} className="input-x w-full" />
        </label>
        <label className="shrink-0 w-24">
          <div className="text-[10px] text-ink-4 mb-1 font-mono-x uppercase tracking-[0.2em]">Tickets</div>
          <input type="number" value={w.capacity}
                 onChange={(e) => onField("capacity", Number(e.target.value))}
                 data-testid={`wave-capacity-${i}`} className="input-x w-full" />
        </label>
        {/* 1 is an ordinary tier. Above it the tier becomes a group ticket: one
            purchase, that many separate QR codes. */}
        <label className="shrink-0 w-28">
          <div className="text-[10px] text-ink-4 mb-1 font-mono-x uppercase tracking-[0.2em]">Tickets per pack</div>
          <input type="number" min="1" max="20" step="1" value={packSize}
                 onChange={(e) => onField("pack_size", Math.max(1, Number(e.target.value) || 1))}
                 data-testid={`wave-pack-size-${i}`} className="input-x w-full" />
        </label>
      </div>

      <div className="mt-3 space-y-3">
        {isPack && (
          <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4"
               data-testid={`wave-pack-note-${i}`}>
            {ron2(Number(w.price_ron) / packSize)} per ticket{" \u00b7 "}
            {capacity ? `${Math.floor(capacity / packSize)} packs` : "no stock yet"}
            {remainder > 0 && (
              <span className="text-brand">{" \u00b7 "}{remainder} ticket{remainder === 1 ? "" : "s"} nobody can buy \u2014 make the count a multiple of {packSize}</span>
            )}
          </div>
        )}
        {/* When the tier sells, who may hold how much of it, and what to say once it is
            gone. The last two used to be the event's, one answer for the whole night;
            they are the tier's now, because "one four-pack per person" and "six general
            admissions per person" are the same rule with different numbers, and a night
            selling both has to be able to say both. */}
        {/* items-end, because one of these labels is not a label. Access carries its
            until/from toggle up on the label line, which makes that line taller than the
            four beside it — bottom-aligned, the CONTROLS still sit on one baseline and the
            taller label grows upward, where there is room for it.

            Access sits last for the same reason: the field that is a different shape
            belongs at the end of the row rather than splitting the four plain ones. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-3 items-end">
          <Field label="Sale starts"><DateTimePicker value={w.starts_at} onChange={(v) => onField("starts_at", v)} /></Field>
          <Field label="Sale ends"><DateTimePicker value={w.ends_at} onChange={(v) => { onTouchEndsAt(); onField("ends_at", v); }} /></Field>
          {/* Blank is not zero, it is "no answer of its own": the tier falls back to the
              event's cap, which is what every tier written before this field existed
              does. The placeholder shows the number that fallback lands on, so an empty
              box still says what the limit will be. */}
          <Field label="Max per user">
            <input type="number" min="1" step="1"
                   value={w.max_tickets_per_user ?? ""}
                   placeholder={eventMaxPerUser == null ? "" : String(eventMaxPerUser)}
                   onChange={(e) => onField("max_tickets_per_user", e.target.value === "" ? null : Number(e.target.value))}
                   data-testid={`wave-max-per-user-${i}`} className="input-x w-full" />
          </Field>
          <Field label="Sold-out message">
            <input placeholder="e.g. Sold Out, At the door" value={w.sold_out_message || ""}
                   onChange={(e) => onField("sold_out_message", e.target.value)}
                   data-testid={`wave-sold-out-message-${i}`} className="input-x w-full" />
          </Field>
          <AccessWindow wave={w} onChange={onFields} index={i} />
        </div>
      </div>
    </div>
  );
}


/** One tier's admission window: which end of it is being set, and when.
 *
 * Two fields on the wave, never both — `access_until` refuses a holder after that
 * moment, `access_from` refuses one before it. The toggle picks which the date means
 * and clears the other, so the pair can never disagree about what an editor intended.
 * Blank is no rule, which is how a tier behaves unless someone says otherwise.
 *
 * Neither end is a hard refusal at the door. The guest is standing there holding a
 * ticket they paid for, so the scanner states which side of the window they are on and
 * a person decides.
 */
export function AccessWindow({ wave, onChange, index }) {
  /* The mode is held here rather than read back off the wave.
   *
   * Deriving it from which field has a value reads well and does not work: on a tier
   * with no date yet — the ordinary case, since people pick the end before the moment —
   * switching to "from" writes an empty `access_from`, and the next render sees two
   * empty fields and snaps the toggle back to "until". The control could not be moved
   * before it had something to hold.
   *
   * Seeded from the wave, so an event that already carries a `from` opens on it.
   */
  const [mode, setMode] = useState(() => (wave.access_from && !wave.access_until ? "from" : "until"));
  const value = mode === "from" ? wave.access_from : wave.access_until;

  const switchTo = (next) => {
    if (next === mode) return;
    setMode(next);
    // The date survives the switch — someone toggling "until" to "from" means the same
    // moment read the other way round, not a field they now have to retype.
    onChange(next === "from"
      ? { access_from: value || "", access_until: "" }
      : { access_until: value || "", access_from: "" });
  };

  return (
    <label className="block min-w-0">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] text-ink-4 font-mono-x uppercase tracking-[0.2em]">Access</span>
        <div className="flex border border-ink/20" data-testid={`wave-access-mode-${index}`}>
          {["until", "from"].map((m) => (
            <button key={m} type="button" onClick={() => switchTo(m)}
                    data-testid={`wave-access-${m}-${index}`}
                    aria-pressed={mode === m}
                    className={`px-2 py-0.5 font-mono-x uppercase tracking-[0.2em] text-[10px] ${
                      mode === m ? "bg-ink text-page" : "text-ink-4 hover:text-ink"}`}>
              {m}
            </button>
          ))}
        </div>
      </div>
      <DateTimePicker
        value={value || ""}
        placeholder="No limit"
        onChange={(v) => onChange(mode === "from"
          ? { access_from: v, access_until: "" }
          : { access_until: v, access_from: "" })} />
    </label>
  );
}

export function EventForm({ form, setForm, onSave, onClose }) {
  /* Functional, because one action can set two fields. Adding the first poster writes the
     collection AND names it the main artwork, and off a captured `form` the second write
     is computed from a copy taken before the first — so `images` was rebuilt without the
     picture that had just been uploaded, and the upload looked like it had failed. The
     same trap `setStartsAt` and `setWaveFields` below already work around. */
  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setWave = (i, k, v) => { const w = [...form.waves]; w[i] = { ...w[i], [k]: v }; setForm({...form, waves: w}); };
  /* Several keys at once. The access toggle has to clear one end as it sets the other,
     and two setWave calls off the same `form` would leave only the second. */
  const setWaveFields = (i, patch) => {
    const w = [...form.waves]; w[i] = { ...w[i], ...patch }; setForm({ ...form, waves: w });
  };

  /* Deleting a tier is a local edit that lands on Save, like every other change in this
     form. Only offered on a tier nothing points at — the server refuses the rest with a
     message naming the tier, so a stale count in this form cannot delete a sale. */
  const removeWave = (i) => {
    const w = form.waves[i];
    if ((Number(w.sold) || 0) > 0 || (Number(w.held) || 0) > 0) return;
    if (!confirm(`Delete "${w.name || "this tier"}"? It has sold nothing, so nothing is lost. Takes effect when you save.`)) return;
    setForm({ ...form, waves: form.waves.filter((_, j) => j !== i) });
  };

  /* Ends, Doors and each tier's sale end are guesses made from Starts, and they follow
   * it until somebody edits them by hand. After that they are that person's answer and
   * are left alone, even if Starts moves again — the alternative is a form that
   * overwrites a deliberate 02:00 curfew the moment the date shifts by a day.
   *
   * Editing an existing event marks nothing as touched, but nothing is derived either:
   * a saved event already has all three, so there is no blank for a guess to fill. */
  const [touched, setTouched] = useState(() => new Set());
  const touch = (path) => setTouched((t) => new Set(t).add(path));
  const held = (path, value) => touched.has(path) || Boolean(value);

  /* Changing when the night starts re-derives everything still following it, in ONE
   * state update — three sequential setForm calls off the same `form` would each
   * overwrite the last, and only the final field would survive. */
  const setStartsAt = (v) => {
    setForm((f) => {
      const next = { ...f, starts_at: v };
      if (!held("ends_at", f.ends_at)) next.ends_at = nextMorningAt6(v);
      if (!held("doors_open_at", f.doors_open_at)) next.doors_open_at = doorsFrom(v);
      next.waves = (f.waves || []).map((w, i) =>
        held(`wave.${i}.ends_at`, null) ? w : { ...w, ends_at: dayBefore(v) || w.ends_at });
      return next;
    });
  };

  const startsInPast = isPast(form.starts_at);

  /* A past date is allowed — an event may be entered after the fact, for the archive or
   * to sell nothing at all. It is confirmed rather than refused, and only when it is
   * about to become real: warning on every keystroke would train the editor to ignore
   * the one that matters. */
  const saveWithPastCheck = () => {
    if (startsInPast &&
        !window.confirm("This event starts in the past. It will show as already finished. Save anyway?")) return;
    onSave();
  };
  const descRef = useRef(null);
  return (
    <div className="fixed inset-0 z-50 bg-[rgba(5,5,5,0.9)] flex items-center justify-center p-4">
      {/* Column layout: the action bar stays pinned while only the body scrolls,
          so Save/Close are reachable from anywhere in a long event form. */}
      <div className="border border-ink/20 bg-surface w-full max-w-[1080px] max-h-[90vh] flex flex-col">
        <div className="shrink-0 flex flex-wrap gap-3 justify-between items-center hairline-b px-6 py-4">
          <div className="font-display text-2xl uppercase font-bold">{form.event_id ? "Edit" : "New"} Event</div>
          <div className="flex gap-2">
            <button onClick={saveWithPastCheck} data-testid="save-event-btn" className="btn-accent">SAVE</button>
            <button onClick={onClose} data-testid="close-event-btn" className="btn-primary">CLOSE</button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
        {/* A stack of rows rather than one two-column grid. What belongs together is a
            LINE now — who and where on the first, when on the second — and a field's
            width is set by how much it needs, not by which cell of a rigid grid it
            happened to land in. Every row collapses to a single column on a phone. */}
        <div className="space-y-3">
          {/* Who and where. Title and Venue get the room; a slug and a city are short.

              Labelled, like every other field in this dialog. These four were the only
              ones relying on a placeholder to say what they were, which is a label that
              disappears exactly when the form stops being empty — so a half-filled event
              showed four boxes of text and no way to tell a venue from a city. */}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
            <Field label="Title" className="sm:col-span-4">
              <input placeholder="Night of the Long Knives" value={form.title}
                     onChange={(e) => setF("title", e.target.value)} className="input-x w-full" />
            </Field>
            <Field label="Slug" className="sm:col-span-2">
              <input placeholder="long-knives" value={form.slug}
                     onChange={(e) => setF("slug", e.target.value)} className="input-x w-full" />
            </Field>
            <Field label="Venue" className="sm:col-span-4">
              <input placeholder="Control Club" value={form.venue}
                     onChange={(e) => setF("venue", e.target.value)} className="input-x w-full" />
            </Field>
            <Field label="City" className="sm:col-span-2">
              <input placeholder="Bucharest" value={form.city || ""}
                     onChange={(e) => setF("city", e.target.value)} className="input-x w-full" />
            </Field>
          </div>
          {/* The three times the event runs on, read together — doors relative to start,
              start relative to end. Image format rides the same line: it is one small
              choice, and giving it a row of its own said it mattered more than it does. */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <Field label="Starts"><DateTimePicker value={form.starts_at} onChange={setStartsAt} /></Field>
            <Field label="Ends"><DateTimePicker value={form.ends_at} onChange={(v) => { touch("ends_at"); setF("ends_at", v); }} /></Field>
            <Field label="Doors"><DateTimePicker value={form.doors_open_at} onChange={(v) => { touch("doors_open_at"); setF("doors_open_at", v); }} /></Field>
            {/* Chosen with the image rather than by each page that shows it, so one event
                cannot be 4:3 on its own page and square in a grid. It was hardcoded to
                4:3 on the event page and set per-block everywhere else. */}
            <Field label="Image format">
              {/* Same reason as the tier's State select: stripped of the native widget's
                  own sizing so it stands level with the date triggers beside it. */}
              <div className="relative">
                <select value={form.image_aspect || "4:3"} onChange={(e) => setF("image_aspect", e.target.value)}
                        className="input-x w-full pr-8 appearance-none" data-testid="event-image-aspect">
                  {EVENT_IMAGE_ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
                <span aria-hidden="true"
                      className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-4 font-mono-x text-[10px]">▼</span>
              </div>
            </Field>
          </div>
          {/* The artwork that sells the night, and which piece of it stands for the event
              elsewhere. Not the albums at the bottom of this dialog: those are a record of
              a night that happened, these are for one that has not. */}
          <PosterField value={form.images} onChange={(v) => setF("images", v)}
                       main={form.image_url} onMainChange={(v) => setF("image_url", v)}
                       label="Posters" testId="event-posters" />
          {/* Said out loud as soon as the date is set, not held back until save — an
              editor who meant to type 2027 should find out while they are still looking
              at the field they mistyped. */}
          {startsInPast && (
            <div className="border border-brand/40 text-brand px-3 py-2 font-mono-x text-[10px] uppercase tracking-[0.2em]"
                 data-testid="event-past-warning">
              This event starts in the past — it will show as already finished.
            </div>
          )}
          {/* Eight rows, and draggable from the corner. At three it was a slot to write a
              paragraph into through a letterbox — and worse, a box that scrolls swallows
              the wheel: a reader who put the cursor over the description and scrolled got
              the description's own overflow, not the dialog they meant to move, which
              reads as the page having seized. Copy that fits does not do that. */}
          <Field label="Description">
            <FormatToolbar textareaRef={descRef} value={form.description} onChange={(v) => setF("description", v)} />
            <textarea ref={descRef} placeholder="Who is playing, what the night is, anything a buyer should know."
                      value={form.description} onChange={(e) => setF("description", e.target.value)}
                      className="input-x w-full resize-y" rows={8} />
          </Field>
          <label className="flex gap-2 items-center"><input type="checkbox" checked={form.is_published} onChange={(e) => setF("is_published", e.target.checked)} /> <span className="text-sm">Published</span></label>
        </div>
        <div className="mt-8 hairline-b pb-3 flex items-baseline gap-3">
          <div className="font-display text-xl uppercase font-bold">Ticket tiers</div>
          <div className="font-mono-x uppercase tracking-[0.2em] text-[10px] text-ink-4">{form.waves.length} tier{form.waves.length === 1 ? "" : "s"}</div>
        </div>
        <div className="mt-4 space-y-4">
          {form.waves.map((w, i) => (
            <TierCard key={w.wave_id || w._key || `new-${i}`} wave={w} index={i}
                      onField={(k, v) => setWave(i, k, v)}
                      onFields={(patch) => setWaveFields(i, patch)}
                      onTouchEndsAt={() => touch(`wave.${i}.ends_at`)}
                      onDelete={() => removeWave(i)}
                      eventMaxPerUser={form.max_tickets_per_user} />
          ))}
          {/* Numbered one past the highest already there, so a new tier lands at the
              bottom of the running order instead of tying with an existing one. Sale
              ends the day before the event; with no date set yet it stays blank and
              fills itself in when Starts is. */}
          <button data-testid="add-tier" onClick={() => setForm({...form, waves: [...form.waves, {
                    _key: `k-${Date.now()}-${Math.random()}`,
                    tier_id: Math.max(0, ...form.waves.map((w) => Number(w.tier_id) || 0)) + 1,
                    name: "NEW", price_ron: 100, capacity: 50,
                    starts_at: new Date().toISOString(),
                    ends_at: dayBefore(form.starts_at),
                    access_until: "", access_from: "",
                    status: "active", pack_size: 1,
                    // Null rather than a copy of the event's number: a new tier inherits
                    // until someone gives it a rule of its own, so changing the event's
                    // cap still moves every tier that never disagreed with it.
                    max_tickets_per_user: null, sold_out_message: "",
                  }]})} className="btn-primary">+ Add tier</button>
        </div>
        <div className="mt-6 hairline-b pb-3 font-mono-x uppercase tracking-[0.2em] text-xs text-ink-4">Albums</div>
        <div className="mt-3">
          {form.event_id
            ? <EventAlbums eventId={form.event_id} />
            : <div className="text-xs text-ink-4 font-mono-x uppercase tracking-[0.2em]">Save the event once first, then link or create its albums.</div>}
        </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The albums attached to one event — several are allowed — with the same manager the
 * Gallery tab uses, so ordering, cover choice and multi-upload behave identically in
 * both places.
 *
 * Linking is the point of this panel. An album is an independent record, so this both
 * attaches existing unlinked albums and creates new ones already attached; either can be
 * detached again without touching the media.
 */
function EventAlbums({ eventId }) {
  const [albums, setAlbums] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [toLink, setToLink] = useState("");

  const load = useCallback(async () => {
    const { data } = await http.get("/admin/albums");
    setAlbums(data);
    return data;
  }, []);

  useEffect(() => { load().catch(() => setAlbums([])); }, [load]);

  const linked = albums.filter((a) => a.event_id === eventId);
  const available = albums.filter((a) => !a.event_id);

  const setLink = async (albumId, event_id) => {
    try {
      await http.patch(`/admin/albums/${albumId}`, { event_id });
      await load();
      toast.success(event_id ? "Album linked" : "Album unlinked");
    } catch (e) {
      const d = e.response?.data?.detail;
      toast.error(typeof d === "string" ? d : "Could not change the link");
    }
  };

  return (
    <div>
      {linked.length === 0 && (
        <div className="text-xs text-ink-4 font-mono-x uppercase tracking-[0.2em] mb-3" data-testid="event-albums-empty">
          No albums linked to this event yet.
        </div>
      )}

      {linked.map((a) => (
        <div key={a.album_id} className="border border-ink/10 mb-3" data-testid={`event-album-row-${a.album_id}`}>
          <div className="flex flex-wrap items-center gap-3 p-3">
            <button onClick={() => setOpenId(openId === a.album_id ? null : a.album_id)}
                    className="font-mono-x text-[11px] uppercase tracking-[0.2em] text-ink hover:underline"
                    data-testid={`event-album-toggle-${a.album_id}`}>
              {openId === a.album_id ? "▾" : "▸"} {a.title}
            </button>
            <span className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4">{a.count} item{a.count === 1 ? "" : "s"}</span>
            <Link to={`/gallery/${a.slug}`} className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 hover:text-ink">
              /gallery/{a.slug} ↗
            </Link>
            {/* Unlinking leaves the album and its media exactly where they are; it just
                stops being this event's. */}
            <button onClick={() => setLink(a.album_id, null)}
                    className="ml-auto font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 hover:text-ink"
                    data-testid={`event-album-unlink-${a.album_id}`}>
              Unlink
            </button>
          </div>
          {openId === a.album_id && (
            <div className="p-3 pt-0">
              <AlbumManager key={a.album_id} albumId={a.album_id} emptyHint="No photos or videos in this album yet." />
            </div>
          )}
        </div>
      ))}

      <div className="border border-ink/10 bg-surface p-3 mt-3">
        <Field label="Link an existing album">
          <div className="flex flex-wrap gap-2">
            <select value={toLink} onChange={(e) => setToLink(e.target.value)}
                    className="input-x flex-1 min-w-[12rem] !text-xs" data-testid="event-album-link-select">
              <option value="">{available.length ? "Choose an unlinked album…" : "No unlinked albums"}</option>
              {available.map((a) => <option key={a.album_id} value={a.album_id}>{a.title} ({a.count})</option>)}
            </select>
            <button onClick={() => { setLink(toLink, eventId); setToLink(""); }} disabled={!toLink}
                    className="btn-primary shrink-0 text-xs disabled:opacity-40" data-testid="event-album-link">
              Link
            </button>
          </div>
        </Field>
        <Field label="…or create one for this event" className="mt-3">
          <NewAlbum eventId={eventId} label="New album title"
                    onCreated={(a) => { load(); setOpenId(a.album_id); }} />
        </Field>
      </div>
    </div>
  );
}

// Two things live under Orders: the purchases (reservations) and the tickets those
// purchases produced. They are different objects with different lifecycles — an order is
// paid or refunded, a ticket is issued, used, denied or refunded — so they get one view
// each rather than one confused list.
/**
 * Transactions: what gets declared.
 *
 * Separate from Orders on purpose. Orders is where you refund somebody; this is where
 * you answer to a tax authority, and the two want different things on screen — the same
 * filters as Stats, a file you can hand over, and a summary whose arithmetic is visible
 * rather than asserted.
 */
function Transactions() {
  const f = useSalesFilters();
  const { query } = f;
  const [summary, setSummary] = useState(null);
  const [showSummary, setShowSummary] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadSummary = async () => {
    setBusy(true);
    try {
      const { data } = await http.get(`/admin/transactions/summary${query ? `?${query}` : ""}`);
      setSummary(data);
      setShowSummary(true);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not build the summary");
    } finally {
      setBusy(false);
    }
  };

  // Re-fetch rather than hide stale numbers behind an open panel: the filters above are
  // the whole point, and a summary that does not follow them is a trap.
  useEffect(() => { if (showSummary) loadSummary(); }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The export goes through the session like every other admin call, so it cannot be a
   *  bare href — that would be an unauthenticated GET and land on the login page. */
  const exportCsv = async () => {
    setBusy(true);
    try {
      const { data } = await http.get(`/admin/transactions.csv${query ? `?${query}` : ""}`, { responseType: "blob" });
      const url = URL.createObjectURL(new Blob([data], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `transactions-${isoDay(new Date())}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("CSV exported");
    } catch {
      toast.error("Export failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <SalesFilters f={f} testId="tx-filters" />

      <div className="flex flex-wrap gap-2 mb-4">
        <button onClick={exportCsv} disabled={busy} className="btn-accent text-xs disabled:opacity-40" data-testid="tx-export-csv">
          Export CSV
        </button>
        <button onClick={showSummary ? () => setShowSummary(false) : loadSummary} disabled={busy}
                className="btn-primary text-xs disabled:opacity-40" data-testid="tx-summary-btn">
          {showSummary ? "Hide" : "Executive summary"}
        </button>
      </div>

      {showSummary && summary && (
        <div className="border border-ink/10 bg-surface p-4" data-testid="tx-summary">
          <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-ink-4">
            Executive summary · {new Date(summary.generated_at).toLocaleString("en-GB")}
          </div>

          {summary.lines.length === 0 ? (
            <div className="mt-4 font-mono-x text-xs uppercase tracking-[0.2em] text-ink-4">Nothing sold in this range</div>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm border-collapse" data-testid="tx-summary-table">
                <thead>
                  <tr className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 text-left">
                    <th className="py-2 pr-3 font-normal">Event</th>
                    <th className="py-2 pr-3 font-normal">Ticket type</th>
                    <th className="py-2 pr-3 font-normal text-right">Sold</th>
                    <th className="py-2 pr-3 font-normal text-right">Unit price</th>
                    <th className="py-2 pr-3 font-normal text-right">Total</th>
                    <th className="py-2 font-normal">Series range</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.lines.map((l, i) => (
                    <tr key={i} className="border-t border-ink/10 align-top" data-testid={`tx-summary-row-${i}`}>
                      <td className="py-2 pr-3 min-w-0">{l.event}</td>
                      <td className="py-2 pr-3 font-mono-x text-xs uppercase">{l.ticket_type || l.type_code}</td>
                      <td className="py-2 pr-3 text-right font-mono-x">{l.tickets_sold}</td>
                      {/* The multiplication is written out because this is the number an
                          auditor recomputes; showing only the product invites the question. */}
                      <td className="py-2 pr-3 text-right font-mono-x">× {money(l.unit_price_ron)}</td>
                      <td className="py-2 pr-3 text-right font-mono-x">{money(l.total_ron)}</td>
                      <td className="py-2 font-mono-x text-[10px] break-all">
                        {l.serial_first ? `${l.serial_first} – ${l.serial_last}` : <span className="text-ink-5">no serials</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-ink/30 font-display font-bold">
                    <td className="py-3 pr-3" colSpan={2}>Total ticket revenue</td>
                    <td className="py-3 pr-3 text-right font-mono-x" data-testid="tx-summary-tickets">{summary.tickets_sold}</td>
                    <td className="py-3 pr-3" />
                    <td className="py-3 pr-3 text-right font-mono-x" data-testid="tx-summary-total">{summary.total_ron.toFixed(2)} RON</td>
                    <td className="py-3" />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {summary.serials_missing > 0 && (
            // Said out loud rather than left to be discovered: tickets issued before
            // serials existed have none, so a range covers fewer tickets than the count
            // beside it, and a fiscal document must not imply otherwise.
            <div className="mt-3 border border-brand px-3 py-2 font-mono-x text-[10px] uppercase tracking-[0.2em] text-brand"
                 data-testid="tx-summary-warning">
              {summary.serials_missing} ticket(s) in this range predate serial numbering and are counted but not covered by a series range
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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
          <div className="lg:col-span-2 min-w-0 font-mono-x">{ron(o.total_ron)}</div>
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
    const price = money(t.price_ron);
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

/**
 * The discipline vocabulary every artist's tags are drawn from. Lives here rather than
 * in its own tab because it is only ever edited while thinking about artists.
 *
 * Removing one does NOT strip it from the artists already carrying it — the server is
 * explicit about that. It stops being offered; the artists keep what they had, and the
 * form marks those values so they can be cleared on purpose.
 */
function DisciplineManager({ disciplines, onChange }) {
  const [adding, setAdding] = useState("");
  const save = async (next) => {
    try {
      const { data } = await http.put("/admin/artists/disciplines", { disciplines: next });
      onChange(data.disciplines);
    } catch (e) { toast.error(e.response?.data?.detail || "Failed"); }
  };
  const add = () => {
    const v = adding.trim();
    if (!v) return;
    if (disciplines.includes(v)) { toast.error("Already on the list"); return; }
    setAdding(""); save([...disciplines, v]);
  };
  return (
    <div className="border border-ink/10 p-4" data-testid="discipline-manager">
      <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4">
        Artistic disciplines
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {disciplines.map((d) => (
          <span key={d} className="px-3 py-1 text-xs font-mono-x uppercase tracking-[0.15em] border border-ink/20 flex items-center gap-2">
            {d}
            <button type="button" onClick={() => save(disciplines.filter((x) => x !== d))}
                    className="text-ink-4 hover:text-ink" aria-label={`Remove ${d}`}
                    data-testid={`discipline-remove-${d}`}>×</button>
          </span>
        ))}
        {disciplines.length === 0 && <span className="text-xs text-ink-4">None yet.</span>}
      </div>
      <div className="mt-3 flex gap-2">
        <input value={adding} onChange={(e) => setAdding(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
               placeholder="Add a discipline…" className="input-x flex-1"
               data-testid="discipline-add-input" />
        <button type="button" onClick={add} className="btn-primary shrink-0"
                data-testid="discipline-add">Add</button>
      </div>
    </div>
  );
}

function Artists() {
  const [items, setItems] = useState([]);
  const [form, setForm] = useState(null);
  const [disciplines, setDisciplines] = useState([]);
  const [albums, setAlbums] = useState([]);
  const load = () => http.get("/admin/artists").then((r) => setItems(r.data));
  useEffect(() => {
    load();
    // The form's three pickers. Fetched once with the tab rather than per open, so
    // reopening the form doesn't re-request a list that has not changed.
    http.get("/admin/artists/disciplines").then((r) => setDisciplines(r.data.disciplines)).catch(() => {});
    http.get("/admin/albums").then((r) => setAlbums(r.data)).catch(() => {});
  }, []);
  const emptyForm = () => ({ name: "", slug: "", bio: "", image_url: "", links: {},
                             disciplines: [], album_ids: [], collab: "resident",
                             other_project_name: "", other_project_url: "" });
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
      setForm(null); load();
      toast.success("Saved");
    } catch (e) { toast.error(e.response?.data?.detail || "Failed"); }
  };
  const del = async (id) => { if (!confirm("Delete?")) return; await http.delete(`/admin/artists/${id}`); load(); };
  return (
    <div>
      <DisciplineManager disciplines={disciplines} onChange={setDisciplines} />
      <button onClick={() => setForm(emptyForm())} className="btn-accent mt-6">+ NEW ARTIST</button>
      <div className="mt-6 space-y-2">
        {items.map((a) => (
          <div key={a.artist_id} className="border border-ink/10 p-3 flex justify-between items-center">
            <div>
              <div className="font-display uppercase">{a.name} · <span className="text-ink-4 text-sm">{a.slug}</span></div>
              {(a.disciplines || []).length > 0 && (
                <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 mt-1">
                  {a.disciplines.join(" · ")}
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={() => setForm({ ...emptyForm(), ...a })} className="btn-primary text-xs">Edit</button>
              <button onClick={() => del(a.artist_id)} className="btn-primary text-xs">Del</button>
            </div>
          </div>
        ))}
      </div>
      {form && <ArtistForm form={form} setForm={setForm} onSave={save} onClose={() => setForm(null)}
                           disciplines={disciplines} albums={albums} />}
    </div>
  );
}

function ArtistForm({ form, setForm, onSave, onClose, disciplines, albums }) {
  const bioRef = useRef(null);
  /* Functional, like setList below and like the event form's setF. Neither of these is
     called twice in one handler today, so nothing here is visibly broken — but that is a
     fact about the current callers rather than about the helper, and the version that
     reads a captured `form` is the one that silently dropped a just-uploaded poster on the
     event side. Cheaper to not leave the trap set. */
  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setLink = (k, v) => setForm((f) => ({ ...f, links: { ...(f.links || {}), [k]: v } }));
  // MultiSelect hands `onChange` a functional updater (see its comment about two ticks
  // in one render) — except "Clear selection", which passes a bare []. Accept both, or
  // clearing stores a function as the value.
  const setList = (k) => (next) => setForm((f) => ({
    ...f,
    [k]: typeof next === "function" ? next(f[k] || []) : next,
  }));
  // A discipline retired from the vocabulary while this artist still carries it stays
  // offered, marked, so it can be cleared on purpose instead of vanishing on save.
  const disciplineOptions = [
    ...disciplines.map((d) => ({ value: d, label: d })),
    ...(form.disciplines || []).filter((d) => !disciplines.includes(d))
      .map((d) => ({ value: d, label: `${d} (retired)` })),
  ];
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
          {/* Two values, closed on the server too: the roster's tabs are built from this
              vocabulary, so a third would put an artist in a group with no tab to reach
              them. Defaults to resident, which is what every artist already on the site
              was set to when the field arrived. */}
          <Field label="Collab" className="col-span-2 md:col-span-1">
            <select value={form.collab || "resident"} onChange={(e) => setF("collab", e.target.value)}
                    className="input-x w-full" data-testid="artist-collab">
              <option value="resident">Resident</option>
              <option value="guest">Guest</option>
            </select>
          </Field>
          <div className="col-span-2">
            <ImageField value={form.image_url} onChange={(v) => setF("image_url", v)}
                        label="Photo" testId="artist-image" />
          </div>
          <div className="col-span-2">
            <MultiSelect label="Disciplines" allLabel="None chosen" testId="artist-disciplines"
                         options={disciplineOptions}
                         selected={form.disciplines || []}
                         onChange={setList("disciplines")} />
          </div>
          <div className="col-span-2">
            <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 mb-1">Bio</div>
            <FormatToolbar textareaRef={bioRef} value={form.bio} onChange={(v) => setF("bio", v)} />
            <textarea ref={bioRef} placeholder="Bio" value={form.bio} onChange={(e) => setF("bio", e.target.value)} className="input-x w-full" rows={4} />
            <div className="text-[10px] text-ink-4 mt-1">
              The artist page shows the first 200 characters, with a “see more” for the rest.
            </div>
          </div>
          <div className="col-span-2">
            <MultiSelect label="Galleries (albums this artist appears in)"
                         allLabel="None chosen" testId="artist-albums"
                         options={albums.map((a) => ({
                           value: a.album_id,
                           label: `${a.title}${a.count ? ` (${a.count})` : ""}`,
                         }))}
                         selected={form.album_ids || []}
                         onChange={setList("album_ids")} />
          </div>
          <div className="col-span-2 mt-2">
            <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 mb-2">
              Other project (outside Supersanity)
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input placeholder="Project name" value={form.other_project_name || ""}
                     onChange={(e) => setF("other_project_name", e.target.value)}
                     className="input-x" data-testid="artist-other-name" />
              <input placeholder="https://…" value={form.other_project_url || ""}
                     onChange={(e) => setF("other_project_url", e.target.value)}
                     className="input-x" data-testid="artist-other-url" />
            </div>
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
        {/* Was a bare text box labelled "Expires ISO", which asked an editor to type a
            timestamp by hand and to know the format. A discount expires at a moment, so
            this is the full picker rather than the date-only one. */}
        <DateTimePicker value={f.expires_at} placeholder="Never expires"
                        onChange={(v) => setF({ ...f, expires_at: v })} />
        <button onClick={save} className="btn-accent col-span-4">ADD</button>
      </div>
      {/* A run of unlabelled values — "SAVE20 · 15%", "uses 3/100" — reads fine to
          whoever built it and to nobody else. The headings say which number is which. */}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full border-collapse" data-testid="discounts-table">
          <thead>
            <tr className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 text-left">
              <th className="hairline-b py-2 pr-3 font-normal">Code</th>
              <th className="hairline-b py-2 pr-3 font-normal">% off</th>
              <th className="hairline-b py-2 pr-3 font-normal">Uses</th>
              <th className="hairline-b py-2 font-normal sr-only">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((d) => (
              <tr key={d.discount_id} className="font-mono-x text-sm" data-testid={`discount-row-${d.code}`}>
                <td className="hairline-b py-3 pr-3 uppercase">{d.code}</td>
                <td className="hairline-b py-3 pr-3">{d.percent_off}%</td>
                <td className="hairline-b py-3 pr-3 text-ink-4">{d.uses}/{d.max_uses || "∞"}</td>
                <td className="hairline-b py-3 text-right">
                  <button onClick={async () => { await http.delete(`/admin/discounts/${d.discount_id}`); load(); }} className="btn-primary text-xs">Del</button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={4} className="py-4 font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4">No discount codes yet</td></tr>
            )}
          </tbody>
        </table>
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
      <div className="mt-4 overflow-x-auto">
        <table className="w-full border-collapse" data-testid="invites-table">
          <thead>
            <tr className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 text-left">
              <th className="hairline-b py-2 pr-3 font-normal">Label</th>
              <th className="hairline-b py-2 pr-3 font-normal">Event</th>
              <th className="hairline-b py-2 pr-3 font-normal">Price</th>
              <th className="hairline-b py-2 pr-3 font-normal">Used</th>
              <th className="hairline-b py-2 pr-3 font-normal">Link</th>
              <th className="hairline-b py-2 font-normal sr-only">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => {
              const ev = events.find((e) => e.event_id === s.event_id);
              const url = ev ? `${window.location.origin}/events/${ev.slug}?invite=${s.token}` : `?invite=${s.token}`;
              return (
                <tr key={s.link_id} className="font-mono-x text-xs" data-testid={`invite-row-${s.link_id}`}>
                  <td className="hairline-b py-3 pr-3 uppercase tracking-[0.2em]">{s.label}</td>
                  {/* An invite whose event was deleted still has a row; saying so beats
                      an empty cell that reads like a rendering fault. */}
                  <td className="hairline-b py-3 pr-3">{ev ? ev.title : <span className="text-ink-4">— deleted —</span>}</td>
                  <td className="hairline-b py-3 pr-3">{ron(s.price_ron)}</td>
                  <td className="hairline-b py-3 pr-3 text-ink-4">{s.used}/{s.capacity}</td>
                  <td className="hairline-b py-3 pr-3 max-w-[22rem]">
                    <Link to={url.replace(window.location.origin, "")} className="text-ink underline break-all">{url}</Link>
                  </td>
                  <td className="hairline-b py-3 text-right">
                    <button onClick={async () => { await http.delete(`/admin/special-links/${s.link_id}`); load(); }} className="btn-primary text-xs">Del</button>
                  </td>
                </tr>
              );
            })}
            {items.length === 0 && (
              <tr><td colSpan={6} className="py-4 font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4">No invite links yet</td></tr>
            )}
          </tbody>
        </table>
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

/** Title, slug, intro and event link for one album. The slug is the URL the album lives
 * at, so it is shown as one — an editor should be able to see what they are changing.
 *
 * These fields used to belong to a single sitewide gallery stored as one settings
 * document, which is why every other album had to borrow its identity from an event. */
function AlbumDetails({ album, events, onSaved, onDeleted }) {
  const [draft, setDraft] = useState(album);
  const [busy, setBusy] = useState(false);
  // Left alone once the editor starts typing a slug of their own; until then it tracks
  // the title, which is what people expect from a slug field.
  const [slugTouched, setSlugTouched] = useState(false);

  useEffect(() => { setDraft(album); setSlugTouched(false); }, [album]);

  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));

  /** Linking an event offers its date, but only into an empty field — an album whose
   * date has been set by hand keeps it, because the two are allowed to differ: photos
   * from a three-day festival get filed under one day of it, not the day it opened. */
  const linkEvent = (event_id) => setDraft((d) => {
    const ev = events.find((e) => e.event_id === event_id);
    const borrowed = ev?.starts_at ? String(ev.starts_at).slice(0, 10) : "";
    return { ...d, event_id, date: d.date || borrowed || null };
  });

  const save = async () => {
    setBusy(true);
    try {
      const { data } = await http.patch(`/admin/albums/${album.album_id}`, {
        title: draft.title,
        slug: draft.slug,
        description: draft.description || "",
        event_id: draft.event_id || null,
        date: draft.date || null,
      });
      setSlugTouched(false);
      onSaved(data);
      toast.success("Album saved");
    } catch (e) {
      const d = e.response?.data?.detail;
      toast.error(typeof d === "string" ? d : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const n = album.count || 0;
    const warning = n
      ? `Delete "${album.title}" and its ${n} item${n === 1 ? "" : "s"}? The files are removed from storage too.`
      : `Delete "${album.title}"?`;
    if (!window.confirm(warning)) return;
    setBusy(true);
    try {
      await http.delete(`/admin/albums/${album.album_id}?delete_items=true`);
      onDeleted(album.album_id);
      toast.success("Album deleted");
    } catch (e) {
      const d = e.response?.data?.detail;
      toast.error(typeof d === "string" ? d : "Could not delete");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-ink/10 bg-surface p-4 mb-4" data-testid="album-details">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Album title">
          <input
            value={draft.title}
            onChange={(e) => {
              set("title", e.target.value);
              if (!slugTouched) set("slug", slugify(e.target.value));
            }}
            className="input-x w-full"
            data-testid="album-title"
          />
        </Field>
        <Field label="Slug">
          <input
            value={draft.slug}
            onChange={(e) => { setSlugTouched(true); set("slug", slugify(e.target.value)); }}
            placeholder="live-documentation"
            className="input-x w-full font-mono-x"
            data-testid="album-slug"
          />
        </Field>
      </div>
      <Field label="Intro (optional)" className="mt-3">
        <input value={draft.description || ""} onChange={(e) => set("description", e.target.value)}
               className="input-x w-full" data-testid="album-description" />
      </Field>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
        {/* An album needs no event. Linking one makes it show on that event's page as
            well as keeping its own tile on the Gallery page. */}
        <Field label="Linked event (optional)">
          <select value={draft.event_id || ""} onChange={(e) => linkEvent(e.target.value || null)}
                  className="input-x w-full" data-testid="album-event">
            <option value="">Not linked to an event</option>
            {events.map((e) => <option key={e.event_id} value={e.event_id}>{e.title}</option>)}
          </select>
        </Field>
        {/* A day, not a moment — an album is filed under the date it documents, and the
            Gallery grid orders newest first by this. The picker's date-only mode: same
            calendar as every other date in the admin, minus a time nobody sets here.
            Left blank, the album falls back to the day it was created. */}
        <Field label="Date">
          <DateTimePicker mode="date" value={draft.date || ""} placeholder="No date"
                          onChange={(v) => set("date", v || null)} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3 mt-3">
        <button onClick={save} disabled={busy} className="btn-accent disabled:opacity-40" data-testid="album-save">
          {busy ? "…" : "SAVE DETAILS"}
        </button>
        <Link to={`/gallery/${album.slug}`} className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 hover:text-ink break-all">
          /gallery/{album.slug} ↗
        </Link>
        <button onClick={remove} disabled={busy} className="ml-auto font-mono-x text-[10px] uppercase tracking-[0.2em] text-danger hover:underline disabled:opacity-40"
                data-testid="album-delete">
          Delete album
        </button>
      </div>
    </div>
  );
}

/** Create an album. Deliberately asks for nothing but a title: an album exists on its
 * own, and the event link (if there ever is one) is set afterwards. */
function NewAlbum({ eventId = null, onCreated, label = "New album" }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    const t = title.trim();
    if (!t) return;
    setBusy(true);
    try {
      const { data } = await http.post("/admin/albums", { title: t, event_id: eventId });
      setTitle("");
      onCreated(data);
      toast.success(`"${data.title}" created`);
    } catch (e) {
      const d = e.response?.data?.detail;
      toast.error(typeof d === "string" ? d : "Could not create the album");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap gap-2">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); create(); } }}
        placeholder={label}
        className="input-x flex-1 min-w-[12rem] !text-xs"
        data-testid="new-album-title"
      />
      <button onClick={create} disabled={busy || !title.trim()}
              className="btn-primary shrink-0 text-xs disabled:opacity-40" data-testid="new-album-create">
        + Create
      </button>
    </div>
  );
}

/** The Gallery tab: every album, linked to an event or not, plus the contents of
 * whichever one is selected. The picker used to list EVENTS — an album could not be
 * chosen because an album was not a thing that existed on its own. */
function GalleryAdmin() {
  const [albums, setAlbums] = useState([]);
  const [events, setEvents] = useState([]);
  const [albumId, setAlbumId] = useState("");

  const loadAlbums = useCallback(async () => {
    const { data } = await http.get("/admin/albums");
    setAlbums(data);
    return data;
  }, []);

  useEffect(() => {
    loadAlbums().then((data) => setAlbumId((id) => id || data[0]?.album_id || "")).catch(() => setAlbums([]));
    http.get("/admin/events").then((r) => setEvents(r.data)).catch(() => setEvents([]));
  }, [loadAlbums]);

  const current = albums.find((a) => a.album_id === albumId);
  const eventTitle = (id) => events.find((e) => e.event_id === id)?.title;

  return (
    <div>
      <div className="border border-ink/10 bg-surface p-4 mb-4">
        <Field label="Album">
          <select value={albumId} onChange={(e) => setAlbumId(e.target.value)} className="input-x w-full" data-testid="gallery-album-select">
            {albums.length === 0 && <option value="">No albums yet</option>}
            {albums.map((a) => (
              <option key={a.album_id} value={a.album_id}>
                {a.title}{a.event_id ? ` · ${eventTitle(a.event_id) || "linked event"}` : ""} ({a.count})
              </option>
            ))}
          </select>
        </Field>
        <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 mt-2">
          {current?.event_id
            ? "Shown on its linked event's page, and as a tile on the Gallery page."
            : "Shown as a tile on the Gallery page. Link it to an event whenever you want to."}
        </div>
        <div className="mt-3 pt-3 hairline-t">
          <NewAlbum onCreated={(a) => { loadAlbums(); setAlbumId(a.album_id); }} label="New album title" />
        </div>
      </div>

      {/* Both this and the manager below remount when the album changes, so neither
          carries state across albums — and their keys must DIFFER from each other:
          two siblings sharing one key is unsupported, and React duplicates them. */}
      {current && (
        <AlbumDetails
          key={`album-details-${current.album_id}`}
          album={current}
          events={events}
          onSaved={() => loadAlbums()}
          onDeleted={(id) => {
            loadAlbums().then((data) => setAlbumId(data.find((a) => a.album_id !== id)?.album_id || ""));
          }}
        />
      )}

      {/* Remount on album change so upload queue and drag state never leak across albums. */}
      {current && (
        <AlbumManager
          key={`album-items-${current.album_id}`}
          albumId={current.album_id}
          emptyHint={`No media in "${current.title}" yet.`}
        />
      )}
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

