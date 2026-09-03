import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { http } from "../api";
import { mediaUrl } from "../lib/media";
import { monthYear } from "../lib/dates";

/** A video row carries a real poster only when its thumbnail differs from the
 * video URL — the upload endpoint reuses the video URL when no frame could be
 * captured. */
const hasPoster = (g) => g.media_type === "video" && g.thumbnail_url && g.thumbnail_url !== g.image_url;

/** One album's tile: a fixed square cover (uniform across the grid) plus a title area
 * that's part of the same CSS Grid row — so a longer title just grows that row's height
 * for every card in it, instead of truncating or breaking alignment. */
function AlbumCard({ album }) {
  const cover = album.cover;
  const isVideo = cover.media_type === "video";
  return (
    <Link
      to={`/gallery/${album.slug}`}
      data-testid={`gallery-album-${album.slug}`}
      className="group flex flex-col h-full border border-ink/10 text-left hover:border-ink transition-colors"
    >
      <div className="aspect-square overflow-hidden relative shrink-0">
        {/* The cover is already a still when a poster exists, so it must render as an
            <img> even though the item is a video — feeding a JPEG to <video> would just
            show an empty box. */}
        {isVideo && !hasPoster(cover) ? (
          <video src={mediaUrl(cover.image_url)} className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition duration-500" muted preload="metadata" />
        ) : (
          <img src={mediaUrl(cover.thumbnail_url || cover.image_url)} alt="" loading="lazy" decoding="async"
               className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition duration-500" />
        )}
        {isVideo && (
          <div className="absolute top-2 left-2 bg-scrim/70 px-2 py-1 font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink">▶ Video</div>
        )}
        {/* The count is a detail you go looking for, not something every tile should
            spend a corner of its cover on, so it waits for the pointer. Keyboard users
            get it on focus for the same reason; on a touch screen, where there is no
            hover to give, it simply stays out of the way. */}
        <div className="absolute bottom-2 right-2 bg-scrim/70 px-2 py-1 font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink
                        opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
             data-testid={`gallery-count-${album.slug}`}>
          {album.count} item{album.count === 1 ? "" : "s"}
        </div>
      </div>
      <div className="flex-1 flex items-center p-3">
        <div className="font-mono-x text-[10px] uppercase tracking-[0.25em] text-ink-3">
          {album.title}
          {/* The date the grid is ordered by, said out loud. An order nobody can read is
              indistinguishable from no order at all. */}
          {monthYear(album.date) && (
            <span className="text-ink-4" data-testid={`gallery-date-${album.slug}`}> · {monthYear(album.date)}</span>
          )}
        </div>
      </div>
    </Link>
  );
}

/**
 * The index of albums. Every tile is an album with a page of its own, whether or not it
 * belongs to an event — the two used to be different kinds of thing here, with loose
 * photos rendered directly into this grid and only event albums getting a tile.
 */
export default function Gallery() {
  const [albums, setAlbums] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    http.get("/gallery/clusters")
      .then((r) => setAlbums(r.data.albums || []))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  return (
    <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-16">
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">Documentation</div>
      <h1 className="font-display text-5xl md:text-7xl uppercase font-black tracking-tighter mt-2" data-testid="gallery-heading">
        Gallery
      </h1>

      <div className="mt-12 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-6 items-stretch">
        {albums.map((a) => <AlbumCard key={a.album_id} album={a} />)}
        {loaded && albums.length === 0 && (
          <div className="col-span-full border border-dashed border-ink/10 p-10 text-center text-ink-4 font-mono-x text-xs uppercase tracking-[0.3em]">Nothing here yet</div>
        )}
      </div>
    </div>
  );
}
