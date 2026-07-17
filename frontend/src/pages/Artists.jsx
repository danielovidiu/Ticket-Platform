import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { http } from "../api";

export default function Artists() {
  const [artists, setArtists] = useState([]);
  useEffect(() => { http.get("/artists").then((r) => setArtists(r.data)).catch(() => {}); }, []);
  return (
    <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-16">
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">Roster</div>
      <h1 className="font-display text-5xl md:text-7xl uppercase font-black tracking-tighter mt-2">Artists</h1>
      <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-4">
        {artists.map((a) => (
          <Link key={a.artist_id} to={`/artists/${a.slug}`} data-testid={`artist-${a.slug}`} className="group block border border-white/10">
            <div className="aspect-square overflow-hidden"><img src={a.image_url} alt={a.name} className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition duration-500" /></div>
            <div className="p-5">
              <div className="font-display uppercase text-xl font-bold tracking-tighter">{a.name}</div>
              <p className="mt-2 text-sm text-zinc-400 line-clamp-2">{a.bio}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
