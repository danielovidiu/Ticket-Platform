import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { http } from "../api";
import { mediaUrl } from "../lib/media";
import { captureVideoPoster } from "../lib/videoPoster";
import { runPipeline, describe, STAGE } from "../lib/uploadPipeline";

// Files are uploaded a few at a time: enough to keep the connection busy without
// stalling the UI or tripping the server's rate limits on a 60-photo drop.
const UPLOAD_CONCURRENCY = 3;

/** True when a video row carries a real poster image rather than reusing the
 * video's own URL (which is what the upload endpoint returns when no poster
 * could be captured). */
const hasPoster = (g) => g.media_type === "video" && g.thumbnail_url && g.thumbnail_url !== g.image_url;

/** A pasted URL carries no Content-Type to inspect, so the extension is all there is to
 * go on. Guessing wrong only picks the wrong element to render it in, which the editor
 * can see immediately in the grid. */
/** What a row in the queue says. A retry is worth showing — an editor watching a file
 * go round a second time is watching it work, not hang. */
function stageLabel(q) {
  if (q.stage === STAGE.DONE) return "✓";
  if (q.stage === STAGE.FAILED) return q.error || "failed";
  const suffix = q.attempt > 1 ? ` · try ${q.attempt}` : "";
  if (q.stage === STAGE.PROCESSING) return `resizing${suffix}`;
  if (q.stage === STAGE.WAITING) return `retrying${suffix}`;
  if (q.stage === STAGE.UPLOADING) return `uploading${suffix}`;
  return "queued";
}

const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|#|$)/i;
const guessMediaType = (url) => (VIDEO_EXT.test(url) ? "video" : "image");

function Tile({ item, index, count, isDragging, isDropTarget, onDragStart, onDragOver, onDragEnd, onDrop, onMove, onSetCover, onDelete, onCaption }) {
  const [caption, setCaption] = useState(item.caption || "");
  useEffect(() => { setCaption(item.caption || ""); }, [item.caption]);

  // Red means "this is the cover" everywhere, so the transient drop-target
  // highlight uses white instead — sharing the colour would make a drag look
  // like it was reassigning the cover.
  const edge = isDropTarget
    ? "border-ink ring-1 ring-ink"
    : item.is_cover
      ? "border-brand"
      : "border-ink/10";

  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; onDragStart(index); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; onDragOver(index); }}
      onDragEnd={onDragEnd}
      onDrop={(e) => { e.preventDefault(); onDrop(index); }}
      data-testid={`album-item-${index}`}
      className={`border bg-surface flex flex-col transition-opacity ${isDragging ? "opacity-40" : "opacity-100"} ${edge}`}
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
          <div className="absolute top-1 left-1 bg-scrim/75 px-1.5 py-0.5 font-mono-x text-[9px] uppercase tracking-[0.15em] text-ink">▶ Video</div>
        )}
        {item.is_cover && (
          <div className="absolute bottom-1 left-1 bg-brand text-page px-1.5 py-0.5 font-mono-x text-[9px] uppercase tracking-[0.15em]" data-testid={`album-cover-badge-${index}`}>Cover</div>
        )}
        <div className="absolute top-1 right-1 bg-scrim/75 px-1.5 py-0.5 font-mono-x text-[9px] text-ink-2">{index + 1}</div>
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
                      ? "!text-brand !border-brand"
                      : "!text-ink-4"
                  }`}
                  data-testid={`album-cover-${index}`}>★</button>
          <button onClick={() => onDelete(item)} title="Delete"
                  className="btn-primary !py-1 !px-0 !text-[10px] flex-1 hover:!text-brand" data-testid={`album-del-${index}`}>✕</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Manages the contents of one album. Ordering, cover choice, captions and deletion all
 * persist immediately — there is no separate save step.
 *
 * The album is identified by `albumId` and nothing else. It used to be identified by the
 * event it hung off (`eventId`, with null meaning the one sitewide gallery), which is
 * why an album could not exist without an event.
 */
export default function AlbumManager({ albumId, emptyHint }) {
  const [items, setItems] = useState([]);
  const [queue, setQueue] = useState([]);
  const [busy, setBusy] = useState(false);
  const [dragFrom, setDragFrom] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const [dropZoneActive, setDropZoneActive] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const [failedIndexes, setFailedIndexes] = useState([]);
  const inputRef = useRef(null);
  // The Files themselves, kept out of state: a retry has to resend the exact bytes the
  // editor dropped, and re-rendering does not need them.
  const filesRef = useRef([]);

  const load = useCallback(async () => {
    if (!albumId) { setItems([]); return; }
    const { data } = await http.get(`/admin/gallery?album_id=${encodeURIComponent(albumId)}`);
    setItems(data);
  }, [albumId]);

  useEffect(() => { load().catch(() => setItems([])); }, [load]);

  const persistOrder = async (ordered) => {
    setItems(ordered); // optimistic — the grid reorders under the cursor immediately
    try {
      await http.patch("/admin/gallery/reorder", { album_id: albumId, ordered_ids: ordered.map((g) => g.gallery_id) });
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

  /**
   * Drop files in, get items out. Two phases, both of which can fail and neither of
   * which used to say why.
   *
   * Phase 1 sends the bytes, a few at a time, through the pipeline: each file is
   * downscaled on this machine first (see lib/imagePipeline — a full-size phone photo
   * is larger than the request body the deployed function accepts, which is what made
   * a 20-photo drop fail on an apparently random handful), and each failure is retried
   * or reported according to what it actually was.
   *
   * Phase 2 creates the rows. Sequential on purpose: the server assigns sort_order as
   * "last + 1", which parallel inserts would race, so the editor's chosen order is only
   * preserved by inserting in it.
   */
  const uploadFiles = async (files) => {
    if (!files.length) return;
    setBusy(true);
    filesRef.current = files;

    setQueue(files.map((file, i) => ({
      key: `${Date.now()}-${i}`, name: file.name, stage: STAGE.QUEUED, attempt: 1,
    })));
    const mark = (i, patch) =>
      setQueue((q) => q.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));

    const send = async (file) => {
      const fd = new FormData();
      fd.append("file", file);
      if (file.type.startsWith("video/")) {
        const poster = await captureVideoPoster(file);
        if (poster) fd.append("poster", poster, "poster.jpg");
      }
      const { data } = await http.post("/admin/uploads", fd);
      return data;
    };

    const results = await runPipeline(files, {
      send,
      concurrency: UPLOAD_CONCURRENCY,
      onUpdate: (i, stage, meta) => mark(i, {
        stage,
        attempt: meta?.attempt ?? 1,
        error: stage === STAGE.FAILED ? describe(meta?.error) : undefined,
      }),
    });

    // Phase 2. A row that fails to be created leaves bytes in storage with nothing
    // pointing at them, so it is worth one retry before it is called a failure.
    let added = 0;
    const rowFailures = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r?.ok) continue;
      const { url, thumbnail_url, media_type } = r.data;
      try {
        await http.post("/admin/gallery", { image_url: url, thumbnail_url, media_type, album_id: albumId });
        added++;
      } catch (first) {
        try {
          await http.post("/admin/gallery", { image_url: url, thumbnail_url, media_type, album_id: albumId });
          added++;
        } catch (err) {
          rowFailures.push(i);
          mark(i, { stage: STAGE.FAILED, error: describe(err) });
        }
      }
    }

    await load();
    setBusy(false);

    // Which files are still worth another go, so the retry button sends only those.
    const failed = results
      .map((r, i) => (r?.ok && !rowFailures.includes(i) ? null : i))
      .filter((i) => i !== null);
    setFailedIndexes(failed);

    if (added) toast.success(`Added ${added} item${added === 1 ? "" : "s"}`);
    if (failed.length) toast.error(`${failed.length} file${failed.length === 1 ? "" : "s"} failed — retry below`);
    // Failures stay on screen until they are retried or dismissed; a clean run clears
    // itself, because a queue of ticks is nothing to read.
    if (!failed.length) setTimeout(() => setQueue([]), 2500);
  };

  /** Send only what failed. The files never left the browser, so this costs the editor
   * nothing but a click — the old flow made them re-pick all twenty. */
  const retryFailed = () => {
    const files = failedIndexes.map((i) => filesRef.current[i]).filter(Boolean);
    if (!files.length) return;
    setFailedIndexes([]);
    uploadFiles(files);
  };

  const addByUrl = async () => {
    const url = urlDraft.trim();
    if (!url) return;
    setBusy(true);
    try {
      const media_type = guessMediaType(url);
      await http.post("/admin/gallery", {
        image_url: url,
        // Nothing to make a thumbnail from when the bytes live elsewhere, so the item
        // is its own thumbnail — the same shape the upload endpoint returns for a video
        // whose poster couldn't be captured.
        thumbnail_url: url,
        media_type,
        album_id: albumId,
      });
      setUrlDraft("");
      await load();
      toast.success(media_type === "video" ? "Video added" : "Image added");
    } catch (e) {
      const d = e.response?.data?.detail;
      toast.error(typeof d === "string" ? d : "Could not add that URL");
    } finally {
      setBusy(false);
    }
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
          dropZoneActive ? "border-brand bg-ink/[0.04]" : "border-ink/25 hover:border-ink/50"
        }`}
      >
        <div className="font-mono-x text-xs uppercase tracking-[0.2em] text-ink-2">
          {busy ? "Uploading…" : "Drop photos & videos here, or click to choose"}
        </div>
        <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 mt-1">
          JPEG, PNG, WebP, GIF, MP4, WebM, MOV · photos are resized here before sending
        </div>
        <input ref={inputRef} type="file" accept="image/*,video/*" multiple className="hidden" data-testid="album-upload-input"
               onChange={(e) => { const f = [...e.target.files]; e.target.value = ""; uploadFiles(f); }} />
      </div>

      {/* Media that already lives somewhere else doesn't need re-hosting. Outside the
          dropzone, or clicking the field would open the file picker. */}
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addByUrl(); } }}
          placeholder="…or paste an image / video URL"
          className="input-x flex-1 min-w-[14rem] !text-xs"
          data-testid="album-url-input"
        />
        <button onClick={addByUrl} disabled={busy || !urlDraft.trim()}
                className="btn-primary shrink-0 text-xs disabled:opacity-40" data-testid="album-url-add">Add URL</button>
      </div>

      {queue.length > 0 && (
        <div className="mt-3 border border-ink/10" data-testid="album-upload-queue">
          <div className="divide-y divide-ink/10">
            {queue.map((q) => (
              <div key={q.key} className="flex items-center justify-between gap-3 px-3 py-1.5 font-mono-x text-[10px] uppercase tracking-[0.15em]">
                <span className="truncate text-ink-3">{q.name}</span>
                <span className={
                  q.stage === STAGE.DONE ? "text-ok shrink-0"
                  : q.stage === STAGE.FAILED ? "text-brand shrink-0"
                  : "text-ink-4 shrink-0"
                } data-testid={`queue-stage-${q.key}`}>
                  {stageLabel(q)}
                </span>
              </div>
            ))}
          </div>
          {failedIndexes.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 hairline-t">
              <span className="font-mono-x text-[10px] uppercase tracking-[0.15em] text-ink-4">
                {failedIndexes.length} failed · the files are still here
              </span>
              <div className="flex gap-2">
                <button onClick={retryFailed} disabled={busy}
                        className="btn-primary text-xs shrink-0 disabled:opacity-40" data-testid="album-retry-failed">
                  Retry {failedIndexes.length}
                </button>
                <button onClick={() => { setFailedIndexes([]); setQueue([]); }}
                        className="font-mono-x text-[10px] uppercase tracking-[0.15em] text-ink-4 hover:text-ink"
                        data-testid="album-dismiss-failed">
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 mt-4 mb-2">
        <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4">
          {items.length} item{items.length === 1 ? "" : "s"}
        </div>
        {items.length > 1 && (
          <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4">Drag to reorder · ★ sets cover</div>
        )}
      </div>

      {items.length === 0 ? (
        <div className="border border-ink/10 p-8 text-center font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4">
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
