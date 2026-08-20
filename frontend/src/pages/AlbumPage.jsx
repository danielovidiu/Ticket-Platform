import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Play } from "lucide-react";
import { http } from "../api";
import { mediaUrl } from "../lib/media";
import { Lightbox } from "../components/ui/lightbox";

/** An album's own page at /gallery/<slug>. This address used to belong to the single
 * sitewide gallery, which redirected anything that wasn't its configured slug; albums
 * are separate records now, so the slug identifies which one to show. */
export default function AlbumPage() {
  const { slug } = useParams();
  const [album, setAlbum] = useState(null);
  const [missing, setMissing] = useState(false);
  const [lbIndex, setLbIndex] = useState(null);

  useEffect(() => {
    setAlbum(null);
    setMissing(false);
    http.get(`/gallery/albums/${encodeURIComponent(slug)}`)
      .then((r) => setAlbum(r.data))
      .catch(() => setMissing(true));
  }, [slug]);

  if (missing) {
    return (
      <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-16">
        <div className="border border-dashed border-ink/10 p-10 text-center text-ink-4 font-mono-x text-xs uppercase tracking-[0.3em]" data-testid="album-missing">
          No such album
        </div>
        <div className="mt-6 text-center">
          <Link to="/gallery" className="font-mono-x text-[10px] uppercase tracking-[0.25em] text-ink-3 hover:text-ink">← All albums</Link>
        </div>
      </div>
    );
  }

  if (!album) return null;

  const items = album.items.map((g) => ({
    url: g.image_url, thumbnail_url: g.thumbnail_url, media_type: g.media_type, caption: g.caption,
  }));

  return (
    <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-16">
      <Link to="/gallery" className="font-mono-x text-[10px] uppercase tracking-[0.25em] text-ink-4 hover:text-ink" data-testid="album-back">
        ← All albums
      </Link>
      <h1 className="font-display text-5xl md:text-7xl uppercase font-black tracking-tighter mt-3" data-testid="album-heading">
        {album.title}
      </h1>

      {/* Only an album that names an event shows one, and it links there rather than
          duplicating the event's own page. */}
      {album.event && (
        <Link to={`/events/${album.event.slug}`} className="inline-block mt-3 font-mono-x text-[10px] uppercase tracking-[0.25em] text-ink-3 hover:text-ink" data-testid="album-event-link">
          From {album.event.title} ↗
        </Link>
      )}

      {album.description && (
        <p className="mt-4 max-w-2xl text-ink-3 text-sm leading-relaxed" data-testid="album-intro">{album.description}</p>
      )}

      <div className="mt-10 columns-2 sm:columns-3 lg:columns-4 gap-2">
        {album.items.map((g, i) => (
          <button
            key={g.gallery_id}
            onClick={() => setLbIndex(i)}
            data-testid={`album-item-${i}`}
            className="mb-2 block w-full break-inside-avoid relative group"
          >
            {g.media_type === "video" ? (
              <>
                {/* Prefer the poster captured at upload: it renders at the same size as a
                    photo and costs one image request instead of a video decode per tile.
                    Items without a poster fall back. */}
                {g.thumbnail_url && g.thumbnail_url !== g.image_url ? (
                  <img src={mediaUrl(g.thumbnail_url)} alt={g.caption || ""} loading="lazy" className="w-full object-cover" />
                ) : (
                  <video src={mediaUrl(g.image_url)} className="w-full object-cover" muted preload="metadata" />
                )}
                <div className="absolute inset-0 flex items-center justify-center bg-scrim/20 group-hover:bg-scrim/10 transition-colors">
                  <Play size={28} className="text-ink" fill="white" />
                </div>
              </>
            ) : (
              <img
                src={mediaUrl(g.thumbnail_url || g.image_url)}
                alt={g.caption || ""}
                loading="lazy"
                className="w-full object-cover group-hover:opacity-80 transition-opacity"
              />
            )}
          </button>
        ))}
      </div>

      {lbIndex !== null && (
        <Lightbox items={items} index={lbIndex} onClose={() => setLbIndex(null)} onIndexChange={setLbIndex} />
      )}
    </div>
  );
}
