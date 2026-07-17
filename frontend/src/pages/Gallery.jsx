import React, { useEffect, useState } from "react";
import { http } from "../api";

export default function Gallery() {
  const [items, setItems] = useState([]);
  useEffect(() => { http.get("/gallery").then((r) => setItems(r.data)).catch(() => {}); }, []);
  return (
    <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-16">
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">Documentation</div>
      <h1 className="font-display text-5xl md:text-7xl uppercase font-black tracking-tighter mt-2">Gallery</h1>
      <div className="mt-12 columns-1 md:columns-3 gap-4 space-y-4">
        {items.map((g) => (
          <figure key={g.gallery_id} className="break-inside-avoid border border-white/10">
            <img src={g.image_url} alt={g.caption} className="w-full block" />
            {g.caption && <figcaption className="p-3 font-mono-x text-[10px] uppercase tracking-[0.25em] text-zinc-500">{g.caption}</figcaption>}
          </figure>
        ))}
      </div>
    </div>
  );
}
