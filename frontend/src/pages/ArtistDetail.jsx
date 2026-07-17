import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { http } from "../api";

export default function ArtistDetail() {
  const { slug } = useParams();
  const [a, setA] = useState(null);
  useEffect(() => { http.get(`/artists/${slug}`).then((r) => setA(r.data)).catch(() => {}); }, [slug]);
  if (!a) return <div className="p-16 text-center font-mono-x text-zinc-500">Loading…</div>;
  return (
    <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-16 grid md:grid-cols-12 gap-10">
      <div className="md:col-span-5">
        <div className="aspect-square overflow-hidden border border-white/10"><img src={a.image_url} alt={a.name} className="w-full h-full object-cover" /></div>
      </div>
      <div className="md:col-span-7">
        <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">Artist</div>
        <h1 className="font-display text-6xl md:text-8xl uppercase font-black tracking-tighter mt-2 leading-none">{a.name}</h1>
        <p className="mt-8 text-zinc-300 text-lg leading-relaxed max-w-xl">{a.bio}</p>
        <div className="mt-8 flex gap-3 flex-wrap">
          {Object.entries(a.links || {}).map(([k, v]) => (
            <a key={k} href={v} target="_blank" rel="noreferrer" className="btn-primary">{k}</a>
          ))}
        </div>
        <Link to="/artists" className="mt-10 inline-block font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-400 hover:text-white">← All artists</Link>
      </div>
    </div>
  );
}
