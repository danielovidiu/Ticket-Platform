import React, { useEffect, useState } from "react";
import { http } from "../api";
import { mediaUrl } from "../lib/media";
import { renderInline } from "../lib/richText";

export default function Archive() {
  const [projects, setProjects] = useState([]);
  const [pastEvents, setPastEvents] = useState([]);
  useEffect(() => {
    http.get("/projects").then((r) => setProjects(r.data)).catch(() => {});
    http.get("/events?upcoming=false").then((r) => setPastEvents(r.data)).catch(() => {});
  }, []);
  return (
    <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-16">
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">Records</div>
      <h1 className="font-display text-5xl md:text-7xl uppercase font-black tracking-tighter mt-2">Archive</h1>

      <h2 className="font-display text-3xl uppercase font-bold tracking-tight mt-16">Projects</h2>
      <div className="mt-6 grid md:grid-cols-2 gap-6">
        {projects.map((p) => (
          <div key={p.project_id} className="border border-ink/10">
            <div className="aspect-[16/9] overflow-hidden"><img src={mediaUrl(p.image_url)} alt={p.title} className="w-full h-full object-cover" /></div>
            <div className="p-6">
              <div className="font-mono-x text-xs uppercase tracking-[0.25em] text-ink-4">{p.year}</div>
              <div className="font-display text-2xl uppercase font-bold tracking-tighter mt-2">{p.title}</div>
              <p className="text-ink-3 mt-3 text-sm">{renderInline(p.description)}</p>
            </div>
          </div>
        ))}
      </div>

      {pastEvents.length > 0 && (
        <>
          <h2 className="font-display text-3xl uppercase font-bold tracking-tight mt-16">Past events</h2>
          <div className="mt-6 divide-y divide-ink/10 border-y border-ink/10">
            {pastEvents.map((e) => (
              <div key={e.event_id} className="grid grid-cols-12 gap-4 py-6">
                <div className="col-span-3 font-mono-x text-xs uppercase text-ink-3">{new Date(e.starts_at).toLocaleDateString("en-GB")}</div>
                <div className="col-span-7 font-display text-xl uppercase font-bold tracking-tight">{e.title}</div>
                <div className="col-span-2 font-mono-x text-xs text-right text-ink-4">{[e.venue, e.city].filter(Boolean).join(", ")}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
