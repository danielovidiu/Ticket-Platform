import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { http } from "../api";
import { ArrowUpRight } from "lucide-react";

const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
};

export default function Home() {
  const [events, setEvents] = useState([]);
  const [artists, setArtists] = useState([]);

  useEffect(() => {
    http.get("/events?upcoming=true").then((r) => setEvents(r.data)).catch(() => {});
    http.get("/artists").then((r) => setArtists(r.data)).catch(() => {});
  }, []);

  const marqueeItems = ["OBSIDIAN · CHAPTER I", "CORPUS · LIVE", "BOX OFFICE OPEN", "VOID ORCHESTRA", "NOKTURN", "LUMEN / CORPS"];

  return (
    <div>
      {/* HERO */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0">
          <img src="https://images.unsplash.com/photo-1545128485-c400e7702796?crop=entropy&cs=srgb&fm=jpg&q=85"
               alt="" className="w-full h-full object-cover opacity-40" />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-[#050505]" />
        </div>
        <div className="relative max-w-[1400px] mx-auto px-6 md:px-10 pt-24 md:pt-32 pb-24">
          <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-400 mb-6">
            BUCHAREST · EST. 2019 · MUSIC · PERFORMANCE
          </div>
          <h1 data-testid="hero-title" className="font-display text-[14vw] md:text-[9vw] leading-[0.85] uppercase tracking-tighter font-black max-w-6xl">
            A collective for<br/>the ones after<br/><span className="text-[color:var(--accent)]">midnight.</span>
          </h1>
          <p className="mt-10 max-w-xl text-zinc-300 leading-relaxed text-lg">
            Umbra programmes music and performance with its own artists and its own box office. No promoter. No middlemen. One door.
          </p>
          <div className="mt-10 flex flex-wrap gap-4">
            <Link to="/events" data-testid="hero-events-btn" className="btn-accent inline-flex items-center gap-2">Buy Tickets <ArrowUpRight size={16} /></Link>
            <Link to="/mission" data-testid="hero-mission-btn" className="btn-primary">Read the manifesto</Link>
          </div>
        </div>
      </section>

      {/* MARQUEE */}
      <section className="hairline-b hairline py-6 overflow-hidden">
        <div className="marquee">
          <div className="marquee-track font-mono-x uppercase tracking-[0.3em] text-2xl md:text-4xl">
            {[...marqueeItems, ...marqueeItems].map((m, i) => (
              <span key={`${m}-${i}`} className="flex items-center gap-16 text-zinc-500">
                {m} <span className="text-[color:var(--accent)]">◆</span>
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* UPCOMING */}
      <section className="max-w-[1400px] mx-auto px-6 md:px-10 py-24">
        <div className="flex items-end justify-between mb-12">
          <div>
            <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">01 — Programme</div>
            <h2 className="font-display text-4xl md:text-6xl uppercase font-bold tracking-tighter mt-3">Upcoming</h2>
          </div>
          <Link to="/events" className="hidden md:inline btn-primary" data-testid="all-events-link">All events</Link>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {events.slice(0, 4).map((e) => (
            <Link key={e.event_id} to={`/events/${e.slug}`} data-testid={`event-card-${e.slug}`}
                  className="group block border border-white/10 bg-[#0F0F0F] hover:border-white transition-colors">
              <div className="aspect-[16/10] overflow-hidden">
                <img src={e.image_url} alt={e.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
              </div>
              <div className="p-6 md:p-8">
                <div className="font-mono-x text-xs uppercase tracking-[0.25em] text-zinc-500">
                  {fmtDate(e.starts_at)} · {e.venue}
                </div>
                <div className="font-display text-3xl md:text-4xl uppercase tracking-tighter font-bold mt-3">{e.title}</div>
                <div className="mt-4 flex items-center justify-between">
                  <div className="font-mono-x text-xs text-zinc-400">
                    {e.total_available > 0 ? `${e.total_available} tickets left` : "SOLD OUT"}
                  </div>
                  <ArrowUpRight size={20} className="text-zinc-400 group-hover:text-white" />
                </div>
              </div>
            </Link>
          ))}
          {events.length === 0 && (
            <div className="col-span-full border border-dashed border-white/10 p-10 text-center text-zinc-500 font-mono-x uppercase text-xs tracking-[0.3em]">
              No upcoming events yet.
            </div>
          )}
        </div>
      </section>

      {/* ARTISTS */}
      <section className="max-w-[1400px] mx-auto px-6 md:px-10 py-24 hairline">
        <div className="flex items-end justify-between mb-12">
          <div>
            <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">02 — Roster</div>
            <h2 className="font-display text-4xl md:text-6xl uppercase font-bold tracking-tighter mt-3">Artists</h2>
          </div>
          <Link to="/artists" className="hidden md:inline btn-primary">All artists</Link>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {artists.slice(0, 6).map((a) => (
            <Link key={a.artist_id} to={`/artists/${a.slug}`} className="group block border border-white/10 overflow-hidden">
              <div className="aspect-square overflow-hidden">
                <img src={a.image_url} alt={a.name} className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition duration-500" />
              </div>
              <div className="p-4 flex items-center justify-between">
                <div className="font-display uppercase tracking-tight font-semibold">{a.name}</div>
                <ArrowUpRight size={16} className="text-zinc-400 group-hover:text-white" />
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* MISSION CTA */}
      <section className="max-w-[1400px] mx-auto px-6 md:px-10 py-24 hairline">
        <div className="grid md:grid-cols-2 gap-10 items-start">
          <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">03 — Mission</div>
          <div>
            <p className="font-display text-3xl md:text-5xl uppercase tracking-tighter leading-tight">
              We build the room, the sound, and the door. We keep the money out of promoters' pockets and inside the work.
            </p>
            <Link to="/mission" className="mt-8 inline-block btn-primary">Read more</Link>
          </div>
        </div>
      </section>
    </div>
  );
}
