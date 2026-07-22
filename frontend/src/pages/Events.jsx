import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { http } from "../api";

const fmtDate = (iso) => {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
};

export default function Events() {
  const [events, setEvents] = useState([]);
  const [tab, setTab] = useState("upcoming");

  useEffect(() => {
    http.get(`/events?upcoming=${tab === "upcoming"}`).then((r) => setEvents(r.data)).catch(() => {});
  }, [tab]);

  return (
    <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-16">
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">Programme</div>
      <div className="flex flex-wrap items-end justify-between gap-6 mt-3">
        <h1 className="font-display text-5xl md:text-7xl uppercase font-black tracking-tighter">Events</h1>
        <div className="flex gap-2">
          <button onClick={() => setTab("upcoming")} data-testid="tab-upcoming"
                  className={`px-4 py-2 border font-mono-x text-xs uppercase tracking-[0.2em] ${tab==="upcoming" ? "bg-white text-black border-white" : "border-white/20 text-zinc-300"}`}>Upcoming</button>
          <button onClick={() => setTab("past")} data-testid="tab-past"
                  className={`px-4 py-2 border font-mono-x text-xs uppercase tracking-[0.2em] ${tab==="past" ? "bg-white text-black border-white" : "border-white/20 text-zinc-300"}`}>Past</button>
        </div>
      </div>

      <div className="mt-12 divide-y divide-white/10 border-y border-white/10">
        {events.map((e) => (
          <Link key={e.event_id} to={`/events/${e.slug}`} data-testid={`event-row-${e.slug}`}
                className="grid grid-cols-12 gap-4 py-8 group hover:bg-white/[0.02] transition-colors">
            <div className="col-span-12 md:col-span-2 font-mono-x text-xs uppercase tracking-[0.2em] text-zinc-400">
              {fmtDate(e.starts_at)}
            </div>
            <div className="col-span-12 md:col-span-6 font-display text-2xl md:text-4xl uppercase tracking-tighter font-bold group-hover:text-[color:var(--accent)]">
              {e.title}
            </div>
            <div className="col-span-6 md:col-span-2 font-mono-x text-xs text-zinc-400 uppercase">{[e.venue, e.city].filter(Boolean).join(", ")}</div>
            <div className="col-span-6 md:col-span-2 font-mono-x text-xs text-right text-zinc-300">
              {tab === "upcoming" ? (e.total_available > 0 ? `${e.total_available} LEFT` : "SOLD OUT") : "ARCHIVED"}
            </div>
          </Link>
        ))}
        {events.length === 0 && <div className="py-24 text-center text-zinc-500 font-mono-x uppercase text-xs tracking-[0.3em]">Nothing here.</div>}
      </div>
    </div>
  );
}
