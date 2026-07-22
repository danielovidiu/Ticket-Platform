import React, { useCallback, useEffect, useRef } from "react";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { mediaUrl } from "../../lib/media";

const SWIPE_THRESHOLD = 50;

/** Full-screen album viewer: fixed-size stage (switching photos never
 * reflows the frame) with a fixed bottom ribbon of uniform 300x300 (90x90 on
 * mobile) thumbnails for direct-jump navigation. Keyboard, click, and touch
 * swipe all drive the same index. */
export function Lightbox({ items, index, onClose, onIndexChange }) {
  const item = items[index];
  const touchX = useRef(null);
  const ribbonRef = useRef(null);

  const go = useCallback(
    (delta) => onIndexChange((index + delta + items.length) % items.length),
    [index, items.length, onIndexChange]
  );

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && items.length > 1) go(-1);
      else if (e.key === "ArrowRight" && items.length > 1) go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose, items.length]);

  // Preload full-res neighbours so paging feels instant.
  useEffect(() => {
    [1, -1].forEach((d) => {
      const neighbour = items[(index + d + items.length) % items.length];
      if (neighbour && neighbour.media_type !== "video") {
        const img = new window.Image();
        img.src = mediaUrl(neighbour.url);
      }
    });
  }, [index, items]);

  // Keep the active ribbon thumb in view as the index changes.
  useEffect(() => {
    const el = ribbonRef.current?.children?.[index];
    el?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [index]);

  const onTouchStart = (e) => { touchX.current = e.touches[0].clientX; };
  const onTouchEnd = (e) => {
    if (touchX.current == null || items.length < 2) return;
    const dx = e.changedTouches[0].clientX - touchX.current;
    if (Math.abs(dx) > SWIPE_THRESHOLD) go(dx < 0 ? 1 : -1);
    touchX.current = null;
  };

  if (!item) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-black flex flex-col" onClick={onClose} data-testid="lightbox">
      <div className="shrink-0 flex items-center justify-between gap-4 px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <span className="font-mono-x text-xs uppercase tracking-[0.2em] text-zinc-400 truncate">{item.caption}</span>
        <div className="flex items-center gap-4 shrink-0">
          {items.length > 1 && (
            <span className="font-mono-x text-xs text-zinc-400" data-testid="lightbox-counter">{index + 1} / {items.length}</span>
          )}
          <button onClick={onClose} className="text-white/70 hover:text-white" data-testid="lightbox-close"><X size={24} /></button>
        </div>
      </div>

      {/* Fixed stage: frame size never changes between photos — object-contain
          letterboxes each image/video inside it instead of resizing the box. */}
      <div
        className="relative flex-1 min-h-0 flex items-center justify-center px-3"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {items.length > 1 && (
          <button onClick={() => go(-1)} className="absolute left-0 sm:left-4 z-10 p-3 text-white/70 hover:text-white" data-testid="lightbox-prev">
            <ChevronLeft size={32} />
          </button>
        )}

        <div className="w-full h-full flex items-center justify-center">
          {item.media_type === "video" ? (
            <video key={item.url} src={mediaUrl(item.url)} controls autoPlay className="max-w-full max-h-full object-contain" />
          ) : (
            <img key={item.url} src={mediaUrl(item.url)} alt={item.caption || ""} className="max-w-full max-h-full object-contain" />
          )}
        </div>

        {items.length > 1 && (
          <button onClick={() => go(1)} className="absolute right-0 sm:right-4 z-10 p-3 text-white/70 hover:text-white" data-testid="lightbox-next">
            <ChevronRight size={32} />
          </button>
        )}
      </div>

      {/* Fixed ribbon: every thumb is the same square size, so the strip
          height never changes as you page through mixed-aspect photos. */}
      {items.length > 1 && (
        <div
          className="shrink-0 border-t border-white/10 bg-black/60 overflow-x-auto overscroll-contain [scrollbar-width:thin]"
          onClick={(e) => e.stopPropagation()}
          data-testid="lightbox-ribbon"
        >
          <div ref={ribbonRef} className="flex gap-2 p-2 w-max mx-auto snap-x snap-mandatory">
            {items.map((it, i) => (
              <button
                key={i}
                onClick={() => onIndexChange(i)}
                data-testid={`lightbox-ribbon-thumb-${i}`}
                className={`relative shrink-0 snap-center w-[90px] h-[90px] sm:w-[300px] sm:h-[300px] overflow-hidden border-2 transition-opacity ${
                  i === index ? "border-white opacity-100" : "border-transparent opacity-50 hover:opacity-90"
                }`}
              >
                {it.media_type === "video" ? (
                  <video src={mediaUrl(it.url)} className="w-full h-full object-cover" muted preload="metadata" />
                ) : (
                  <img
                    src={mediaUrl(it.thumbnail_url || it.url)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="w-full h-full object-cover"
                  />
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
