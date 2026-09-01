import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { http } from "../api";
import { mediaUrl } from "../lib/media";

// How many discipline tags a tile shows before it stops listing them. Three fits the
// column at every breakpoint without wrapping to a third line; the rest are counted.
const SHOWN = 3;

export default function Artists() {
  const [artists, setArtists] = useState([]);
  // Already A-Z from the server, which folds case — see list_artists. Sorting again here
  // would only be a second opinion that could disagree.
  useEffect(() => { http.get("/artists").then((r) => setArtists(r.data)).catch(() => {}); }, []);
  return (
    <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-16">
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">Roster</div>
      <h1 className="font-display text-5xl md:text-7xl uppercase font-black tracking-tighter mt-2">Artists</h1>
      <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-4">
        {artists.map((a) => {
          const tags = a.disciplines || [];
          const rest = tags.length - SHOWN;
          return (
            <Link key={a.artist_id} to={`/artists/${a.slug}`} data-testid={`artist-${a.slug}`} className="group block border border-ink/10">
              {a.image_url && (
                <div className="aspect-square overflow-hidden"><img src={mediaUrl(a.image_url)} alt={a.name} className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition duration-500" /></div>
              )}
              <div className="p-5">
                <div className="font-display uppercase text-xl font-bold tracking-tighter">{a.name}</div>
                {tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4"
                       data-testid={`artist-${a.slug}-disciplines`}>
                    {tags.slice(0, SHOWN).map((d) => <span key={d}>{d}</span>)}
                    {/* Text, not an anchor: the whole tile is already a link to this
                        artist, and an <a> inside an <a> is invalid and unclickable. */}
                    {rest > 0 && <span className="text-ink-3 group-hover:text-ink">+{rest} more</span>}
                  </div>
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
