import React, { useEffect, useState } from "react";
import { http } from "../api";
import { mediaUrl } from "../lib/media";
import { Lightbox } from "../components/ui/lightbox";

/** A video row carries a real poster only when its thumbnail differs from the
 * video URL — the upload endpoint reuses the video URL when no frame could be
 * captured. */
const hasPoster = (g) => g.media_type === "video" && g.thumbnail_url && g.thumbnail_url !== g.image_url;

/** Card shape shared by event-cluster covers and standalone photos: a fixed
 * square cover (uniform across the grid) plus a title area that's part of
 * the same CSS Grid row — so a longer title just grows that row's height for
 * every card in it, instead of truncating or breaking alignment. */
function Card({ testId, coverUrl, isVideo, isPoster, title, badge, onClick }) {
  return (
    <button onClick={onClick} data-testid={testId} className="group flex flex-col h-full border border-white/10 text-left hover:border-white transition-colors">
      <div className="aspect-square overflow-hidden relative shrink-0">
        {/* `coverUrl` is already a still when a poster exists, so it must render as
            an <img> even though the item is a video — feeding a JPEG to <video>
            would just show an empty box. */}
        {isVideo && !isPoster ? (
          <video src={coverUrl} className="w-full h-full object-cover" muted preload="metadata" />
        ) : (
          <img src={coverUrl} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover group-hover:opacity-80 transition-opacity" />
        )}
        {isVideo && (
          <div className="absolute top-2 left-2 bg-black/70 px-2 py-1 font-mono-x text-[10px] uppercase tracking-[0.2em] text-white">▶ Video</div>
        )}
        {badge && (
          <div className="absolute bottom-2 right-2 bg-black/70 px-2 py-1 font-mono-x text-[10px] uppercase tracking-[0.2em] text-white">{badge}</div>
        )}
      </div>
      {title && (
        <div className="flex-1 flex items-center p-3">
          <div className="font-mono-x text-[10px] uppercase tracking-[0.25em] text-zinc-400">{title}</div>
        </div>
      )}
    </button>
  );
}

export default function Gallery() {
  const [standalone, setStandalone] = useState([]);
  const [eventAlbums, setEventAlbums] = useState([]);
  const [active, setActive] = useState(null); // { items, index }
  useEffect(() => {
    http.get("/gallery/clusters").then((r) => {
      setStandalone(r.data.standalone);
      setEventAlbums(r.data.event_albums);
    }).catch(() => {});
  }, []);

  const toItems = (list) => list.map((g) => ({ url: g.image_url, thumbnail_url: g.thumbnail_url, media_type: g.media_type, caption: g.caption }));

  return (
    <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-16">
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">Documentation</div>
      <h1 className="font-display text-5xl md:text-7xl uppercase font-black tracking-tighter mt-2">Gallery</h1>

      <div className="mt-12 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-6 items-stretch">
        {eventAlbums.map((a) => (
          <Card
            key={a.event_id}
            testId={`gallery-event-${a.slug}`}
            coverUrl={mediaUrl(a.cover.thumbnail_url || a.cover.image_url)}
            isVideo={a.cover.media_type === "video"}
            isPoster={hasPoster(a.cover)}
            title={a.title}
            badge={`${a.count} photo${a.count === 1 ? "" : "s"}`}
            onClick={() => setActive({ items: toItems(a.items), index: 0 })}
          />
        ))}
        {standalone.map((g, i) => (
          <Card
            key={g.gallery_id}
            testId={`gallery-standalone-${i}`}
            coverUrl={mediaUrl(g.thumbnail_url || g.image_url)}
            isVideo={g.media_type === "video"}
            isPoster={hasPoster(g)}
            title={g.caption}
            onClick={() => setActive({ items: toItems(standalone), index: i })}
          />
        ))}
        {eventAlbums.length === 0 && standalone.length === 0 && (
          <div className="col-span-full border border-dashed border-white/10 p-10 text-center text-zinc-500 font-mono-x text-xs uppercase tracking-[0.3em]">Nothing here yet</div>
        )}
      </div>

      {active && (
        <Lightbox
          items={active.items}
          index={active.index}
          onClose={() => setActive(null)}
          onIndexChange={(i) => setActive({ ...active, index: i })}
        />
      )}
    </div>
  );
}
