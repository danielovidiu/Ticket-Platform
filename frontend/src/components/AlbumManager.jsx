import React, { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { http } from "../api";
import { mediaUrl } from "../lib/media";
import { captureVideoPoster } from "../lib/videoPoster";

// Files are uploaded a few at a time: enough to keep the connection busy without
// stalling the UI or tripping the server's rate limits on a 60-photo drop.
const UPLOAD_CONCURRENCY = 3;

/** True when a video row carries a real poster image rather than reusing the
 * video's own URL (which is what the upload endpoint returns when no poster
 * could be captured). */
const hasPoster = (g) => g.media_type === "video" && g.thumbnail_url && g.thumbnail_url !== g.image_url;

function Tile({ item, index, count, isDragging, isDropTarget, onDragStart, onDragOver, onDragEnd, onDrop, onMove, onSetCover, onDelete, onCaption }) {
  const [caption, setCaption] = useState(item.caption || "");
  useEffect(() => { setCaption(item.caption || ""); }, [item.caption]);

  // Red means "this is the cover" everywhere, so the transient drop-target
  // highlight uses white instead — sharing the colour would make a drag look
  // like it was reassigning the cover.
  const edge = isDropTarget
    ? "border-white ring-1 ring-white"
    : item.is_cover
      ? "border-[color:var(--accent)]"
      : "border-white/10";

  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; onDragStart(index); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; onDragOver(index); }}
      onDragEnd={onDragEnd}
      onDrop={(e) => { e.preventDefault(); onDrop(index); }}
      data-testid={`album-item-${index}`}
      className={`border bg-[#0F0F0F] flex flex-col transition-opacity ${isDragging ? "opacity-40" : "opacity-100"} ${edge}`}
    >
      <div className="relative aspect-square overflow-hidden cursor-grab active:cursor-grabbing">
        {item.media_type === "video" && !hasPoster(item) ? (
          // No poster could be captured — fall back to the video element itself.
          <video src={mediaUrl(item.image_url)} className="w-full h-full object-cover" muted preload="metadata" />
        ) : (
          <img src={mediaUrl(item.thumbnail_url || item.image_url)} alt={item.caption || ""} loading="lazy"
               className="w-full h-full object-cover pointer-events-none" />
        )}
        {item.media_type === "video" && (
          <div className="absolute top-1 left-1 bg-black/75 px-1.5 py-0.5 font-mono-x text-[9px] uppercase tracking-[0.15em] text-white">▶ Video</div>
        )}
        {item.is_cover && (
          <div className="absolute bottom-1 left-1 bg-[color:var(--accent)] text-black px-1.5 py-0.5 font-mono-x text-[9px] uppercase tracking-[0.15em]" data-testid={`album-cover-badge-${index}`}>Cover</div>
        )}
        <div className="absolute top-1 right-1 bg-black/75 px-1.5 py-0.5 font-mono-x text-[9px] text-zinc-300">{index + 1}</div>
      </div>

      <div className="p-1.5 flex flex-col gap-1.5">
        <input
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          onBlur={() => { if ((item.caption || "") !== caption) onCaption(item, caption); }}
          placeholder="Caption"
          className="input-x !py-1 !px-2 !text-[10px] w-full"
          data-testid={`album-caption-${index}`}
        />
        {/* Arrows exist because HTML5 drag-and-drop does not fire on touch devices. */}
        <div className="flex gap-1">
          <button onClick={() => onMove(index, index - 1)} disabled={index === 0} title="Move earlier"
                  className="btn-primary !py-1 !px-0 !text-[10px] flex-1 disabled:opacity-30" data-testid={`album-left-${index}`}>←</button>
          <button onClick={() => onMove(index, index + 1)} disabled={index === count - 1} title="Move later"
                  className="btn-primary !py-1 !px-0 !text-[10px] flex-1 disabled:opacity-30" data-testid={`album-right-${index}`}>→</button>
          {/* The cover's star is the one that should stand out. It used to be the
              dimmed one, because being the cover disables the button and the
              disabled style faded it — exactly backwards. Red = cover, grey = not. */}
          <button onClick={() => onSetCover(item)} disabled={item.is_cover}
                  title={item.is_cover ? "This is the album cover" : "Use as album cover"}
                  aria-label={item.is_cover ? "Current album cover" : "Set as album cover"}
                  className={`btn-primary !py-1 !px-0 !text-[12px] !leading-none flex-1 disabled:cursor-default ${
                    item.is_cover
                      ? "!text-[color:var(--accent)] !border-[color:var(--accent)]"
                      : "!text-zinc-500"
                  }`}
                  data-testid={`album-cover-${index}`}>★</button>
          <button onClick={() => onDelete(item)} title="Delete"
                  className="btn-primary !py-1 !px-0 !text-[10px] flex-1 hover:!text-[color:var(--accent)]" data-testid={`album-del-${index}`}>✕</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Manages one album: the sitewide gallery when `eventId` is null, or a single
 * event's collection. Ordering, cover choice, captions and deletion all persist
 * immediately — there is no separate save step.
 */
export default function AlbumManager({ eventId = null, emptyHint }) {
  const [items, setItems] = useState([]);
  const [queue, setQueue] = useState([]);
  const [busy, setBusy] = useState(false);
  const [dragFrom, setDragFrom] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const [dropZoneActive, setDropZoneActive] = useState(false);
  const inputRef = useRef(null);

  const load = useCallback(async () => {
    const qs = eventId ? `?event_id=${encodeURIComponent(eventId)}` : "";
    const { data } = await http.get(`/admin/gallery${qs}`);
    setItems(data);
  }, [eventId]);

  useEffect(() => { load().catch(() => setItems([])); }, [load]);

  const persistOrder = async (ordered) => {
    setItems(ordered); // optimistic — the grid reorders under the cursor immediately
    try {
      await http.patch("/admin/gallery/reorder", { event_id: eventId, ordered_ids: ordered.map((g) => g.gallery_id) });
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not save order");
      load();
    }
  };

  const move = (from, to) => {
    if (to < 0 || to >= items.length || from === to) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    persistOrder(next);
  };

  const setCover = async (item) => {
    setItems((prev) => prev.map((g) => ({ ...g, is_cover: g.gallery_id === item.gallery_id })));
    try {
      await http.patch(`/admin/gallery/${item.gallery_id}`, { is_cover: true });
    } catch {
      toast.error("Could not set cover");
      load();
    }
  };

  const saveCaption = async (item, caption) => {
    try {
      await http.patch(`/admin/gallery/${item.gallery_id}`, { caption });
      setItems((prev) => prev.map((g) => (g.gallery_id === item.gallery_id ? { ...g, caption } : g)));
    } catch {
      toast.error("Could not save caption");
    }
  };

  const remove = async (item) => {
    if (!window.confirm("Delete this item? The file is removed from storage too.")) return;
    try {
      await http.delete(`/admin/gallery/${item.gallery_id}`);
      await load();
    } catch {
      toast.error("Could not delete");
    }
  };

  const uploadFiles = async (files) => {
    if (!files.length) return;
    setBusy(true);
    const entries = files.map((file, i) => ({ key: `${Date.now()}-${i}`, name: file.name, file, status: "pending" }));
    setQueue(entries.map(({ file, ...rest }) => rest));
    const mark = (key, status, error) =>
      setQueue((q) => q.map((e) => (e.key === key ? { ...e, status, error } : e)));

    // Phase 1 — push the bytes up a few at a time. Results are keyed by the
    // original index so the user's selection order survives the parallelism.
    const results = new Array(entries.length).fill(null);
    let cursor = 0;
    const worker = async () => {
      while (cursor < entries.length) {
        const i = cursor++;
        const entry = entries[i];
        mark(entry.key, "uploading");
        try {
          const fd = new FormData();
          fd.append("file", entry.file);
          if (entry.file.type.startsWith("video/")) {
            const poster = await captureVideoPoster(entry.file);
            if (poster) fd.append("poster", poster, "poster.jpg");
          }
          const { data } = await http.post("/admin/uploads", fd);
          results[i] = data;
          mark(entry.key, "done");
        } catch (err) {
          mark(entry.key, "error", err.response?.data?.detail || "Upload failed");
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, entries.length) }, worker));

    // Phase 2 — create the rows strictly in order. Sequential on purpose: the
    // server assigns sort_order as "last + 1", which parallel inserts would race.
    let added = 0;
    for (const data of results) {
      if (!data) continue;
      try {
        await http.post("/admin/gallery", {
          image_url: data.url, thumbnail_url: data.thumbnail_url, media_type: data.media_type, event_id: eventId,
        });
        added++;
      } catch {
        /* surfaced by the failure count below */
      }
    }

    await load();
    setBusy(false);
    const failed = entries.length - added;
    if (added) toast.success(`Added ${added} item${added === 1 ? "" : "s"}`);
    if (failed > 0) toast.error(`${failed} file${failed === 1 ? "" : "s"} failed`);
    setTimeout(() => setQueue([]), failed > 0 ? 8000 : 2500);
  };

  const onDropFiles = (e) => {
    e.preventDefault();
    setDropZoneActive(false);
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"));
    if (files.length) uploadFiles(files);
  };

  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDropZoneActive(true); }}
        onDragLeave={() => setDropZoneActive(false)}
        onDrop={onDropFiles}
        onClick={() => inputRef.current?.click()}
        data-testid="album-dropzone"
        className={`border border-dashed p-6 text-center cursor-pointer transition-colors ${
          dropZoneActive ? "border-[color:var(--accent)] bg-white/[0.04]" : "border-white/25 hover:border-white/50"
        }`}
      >
        <div className="font-mono-x text-xs uppercase tracking-[0.2em] text-zinc-300">
          {busy ? "Uploading…" : "Drop photos & videos here, or click to choose"}
        </div>
        <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-zinc-500 mt-1">
          Multiple files supported · JPEG, PNG, WebP, GIF, MP4, WebM, MOV · 25MB each
        </div>
        <input ref={inputRef} type="file" accept="image/*,video/*" multiple className="hidden" data-testid="album-upload-input"
               onChange={(e) => { const f = [...e.target.files]; e.target.value = ""; uploadFiles(f); }} />
      </div>

      {queue.length > 0 && (
        <div className="mt-3 border border-white/10 divide-y divide-white/10" data-testid="album-upload-queue">
          {queue.map((q) => (
            <div key={q.key} className="flex items-center justify-between gap-3 px-3 py-1.5 font-mono-x text-[10px] uppercase tracking-[0.15em]">
              <span className="truncate text-zinc-400">{q.name}</span>
              <span className={
                q.status === "done" ? "text-[color:var(--success)] shrink-0"
                : q.status === "error" ? "text-[color:var(--accent)] shrink-0"
                : "text-zinc-500 shrink-0"
              }>
                {q.status === "done" ? "✓" : q.status === "error" ? (q.error || "failed") : q.status}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 mt-4 mb-2">
        <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-zinc-500">
          {items.length} item{items.length === 1 ? "" : "s"}
        </div>
        {items.length > 1 && (
          <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-zinc-500">Drag to reorder · ★ sets cover</div>
        )}
      </div>

      {items.length === 0 ? (
        <div className="border border-white/10 p-8 text-center font-mono-x text-[10px] uppercase tracking-[0.2em] text-zinc-500">
          {emptyHint || "Nothing here yet."}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2" data-testid="album-grid">
          {items.map((item, i) => (
            <Tile
              key={item.gallery_id}
              item={item}
              index={i}
              count={items.length}
              isDragging={dragFrom === i}
              isDropTarget={dragOver === i && dragFrom !== null && dragFrom !== i}
              onDragStart={setDragFrom}
              onDragOver={setDragOver}
              onDragEnd={() => { setDragFrom(null); setDragOver(null); }}
              onDrop={(to) => { if (dragFrom !== null) move(dragFrom, to); setDragFrom(null); setDragOver(null); }}
              onMove={move}
              onSetCover={setCover}
              onDelete={remove}
              onCaption={saveCaption}
            />
          ))}
        </div>
      )}
    </div>
  );
}
