import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { http } from "../api";
import { useCorePageHeader } from "../lib/corePageHeader";
import PageHeader from "../components/PageHeader";

const fmtDate = (iso) => {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
};

const TAB_LABELS = { all: "All", upcoming: "Upcoming", past: "Past" };

// The tab drives one query parameter, and "all" is the absence of it — /events treats
// `upcoming` as a tri-state where omitted means the whole programme.
const QUERY = { all: "", upcoming: "?upcoming=true", past: "?upcoming=false" };

/**
 * Whether an event has finished, judged the same way the server judges it: by `ends_at`,
 * falling back to `starts_at` when no end time is set.
 *
 * This used to be read off the active tab, which was sound while the only two tabs were
 * "upcoming" and "past" and a list could only hold one kind. The All tab mixes them, so
 * the question has to be asked of each event instead — otherwise every row on All claims
 * the status of whichever tab happened to be selected.
 */
const isPast = (e) => new Date(e.ends_at || e.starts_at).getTime() < Date.now();

export default function Events() {
  const [events, setEvents] = useState([]);
  // Which tabs exist and which one opens is a CMS setting. Until it arrives there is no
  // tab bar and no fetch: guessing a default here would show one slice of the programme
  // and then swap it under the visitor a moment later.
  const [settings, setSettings] = useState(null);
  const [tab, setTab] = useState(null);
  const header = useCorePageHeader("events");

  useEffect(() => {
    http.get("/cms/events-settings")
      .then((r) => { setSettings(r.data); setTab(r.data.default_tab); })
      .catch(() => { setSettings({ tabs: ["all", "upcoming", "past"], default_tab: "all" }); setTab("all"); });
  }, []);

  useEffect(() => {
    if (!tab) return;
    http.get(`/events${QUERY[tab] ?? ""}`).then((r) => setEvents(r.data)).catch(() => {});
  }, [tab]);

  const tabs = settings?.tabs || [];

  return (
    /* space-y rather than margins on the sections: the header is CMS content and can be
       emptied, and a gap that belongs to the thing above it disappears with it. */
    <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-16 space-y-12">
      <PageHeader
        header={header}
        eyebrowTestId="events-eyebrow"
        headingTestId="events-heading"
        /* One tab is not a choice, so the bar only appears when there is something to
           choose between. An editor who leaves a single tab enabled gets that filter
           applied silently rather than a control that cannot be changed. */
        aside={tabs.length > 1 ? (
          <div className="flex gap-2" data-testid="event-tabs">
            {tabs.map((t) => (
              <button key={t} onClick={() => setTab(t)} data-testid={`tab-${t}`}
                      aria-pressed={tab === t}
                      className={`px-4 py-2 border font-mono-x text-xs uppercase tracking-[0.2em] ${tab === t ? "bg-ink text-page border-ink" : "border-ink/20 text-ink-2"}`}>
                {TAB_LABELS[t] || t}
              </button>
            ))}
          </div>
        ) : null}
      />

      <div className="divide-y divide-ink/10 border-y border-ink/10">
        {events.map((e) => (
          <Link key={e.event_id} to={`/events/${e.slug}`} data-testid={`event-row-${e.slug}`}
                className="grid grid-cols-12 gap-4 py-8 group hover:bg-ink/[0.02] transition-colors">
            <div className="col-span-12 md:col-span-2 font-mono-x text-xs uppercase tracking-[0.2em] text-ink-3">
              {fmtDate(e.starts_at)}
            </div>
            <div className="col-span-12 md:col-span-6 font-display text-2xl md:text-4xl uppercase tracking-tighter font-bold group-hover:text-brand">
              {e.title}
            </div>
            <div className="col-span-6 md:col-span-2 font-mono-x text-xs text-ink-3 uppercase">{[e.venue, e.city].filter(Boolean).join(", ")}</div>
            <div className="col-span-6 md:col-span-2 font-mono-x text-xs text-right text-ink-2">
              {/* Same rule as the event page: sold out and nearly-gone are worth saying,
                  the exact count is not published. */}
              {isPast(e)
                ? "ARCHIVED"
                : (e.total_available <= 0 ? "SOLD OUT" : e.total_available < 10 ? "ONLY A FEW LEFT" : "ON SALE")}
            </div>
          </Link>
        ))}
        {events.length === 0 && <div className="py-24 text-center text-ink-4 font-mono-x uppercase text-xs tracking-[0.3em]">Nothing here.</div>}
      </div>
    </div>
  );
}
