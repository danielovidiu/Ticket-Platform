import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { http } from "../api";
import { mediaUrl } from "../lib/media";
import { runPipeline, STAGE } from "../lib/uploadPipeline";

/** What a file in flight is doing, in the album manager's words — the two lists sit in
 *  the same admin and should not describe the same pipeline differently. */
function stageLabel(q) {
  if (q.stage === STAGE.DONE) return "✓";
  if (q.stage === STAGE.FAILED) return q.error || "failed";
  const suffix = q.attempt > 1 ? ` ${q.attempt}/3` : "";
  if (q.stage === STAGE.PROCESSING) return `resizing${suffix}`;
  if (q.stage === STAGE.WAITING) return `retrying${suffix}`;
  if (q.stage === STAGE.UPLOADING) return `uploading${suffix}`;
  return "queued";
}

/**
 * An event's poster collection, and which piece of it is the main artwork.
 *
 * This is deliberately NOT the album manager. An album is a record of a night that
 * happened: it is a saved row with an id, it can be linked and unlinked, and its media
 * lives on the server the moment it is added. Posters are artwork for a night that has not
 * happened yet, and an editor is filling this in *while inventing the event* — so the
 * whole collection is held in form state and saved with everything else. That is the one
 * thing the album route could not do, and the reason a new event can have artwork at all.
 *
 * `value` is the ordered list; `main` is the one that stands for the event everywhere
 * else. They are separate props because they are separate fields on the event — `images`
 * and `image_url` — and `image_url` is what every card, every notice email and the top of
 * the event page already reads.
 */
export default function PosterField({
  value, onChange, main, onMainChange, label = "Posters", testId = "event-posters",
}) {
  const inputRef = useRef(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(0);   // how many files are still in flight
  const [over, setOver] = useState(false);
  const [queue, setQueue] = useState([]);
  /* Memoized on `value`, not rebuilt per render. The `[]` branch allocates a NEW empty
     array every time, so an unset field handed `append` a fresh dependency on every
     render — the callback was rebuilt each pass and any child taking it as a prop lost
     its memoization. Keyed on `value` itself, an unchanged field yields the same array. */
  const posters = useMemo(() => (Array.isArray(value) ? value : []), [value]);

  const send = useCallback(async (file) => {
    const fd = new FormData();
    fd.append("file", file);
    const { data } = await http.post("/admin/uploads", fd);
    return data;
  }, []);

  /* The first poster added becomes the main artwork on its own. Asking an editor to
     nominate one when there is only one to nominate is a question with a single answer. */
  const append = useCallback((urls) => {
    if (!urls.length) return;
    const next = [...posters, ...urls.filter((u) => !posters.includes(u))];
    onChange(next);
    if (!main) onMainChange(urls[0]);
  }, [posters, onChange, main, onMainChange]);

  const upload = async (files) => {
    const picked = [...files].filter((f) => f.type.startsWith("image/"));
    if (picked.length !== files.length) toast.error("Posters are images — video belongs in an album");
    if (!picked.length) return;

    setBusy(picked.length);
    /* A row per file, updated as the pipeline moves it along. The button used to say
       "Uploading 3…" and nothing else, so a slow file, a retry and a failure all looked
       identical from outside — and a poster that never arrived looked like a control that
       had done nothing. The album manager has answered this since it was written; this is
       the same answer. */
    setQueue(picked.map((file, i) => ({
      key: `${Date.now()}-${i}`, name: file.name, stage: STAGE.QUEUED, attempt: 1,
    })));
    const mark = (i, patch) =>
      setQueue((q) => q.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));

    const results = await runPipeline(picked, {
      send,
      onUpdate: (i, stage, meta) => mark(i, {
        stage,
        attempt: meta?.attempt ?? 1,
        error: stage === STAGE.FAILED ? meta?.message : undefined,
      }),
    });
    setBusy(0);

    const ok = results.filter((r) => r?.ok).map((r) => r.data.url);
    const failed = results.length - ok.length;
    append(ok);
    if (ok.length) toast.success(`${ok.length} poster${ok.length === 1 ? "" : "s"} added`);
    if (failed) toast.error(`${failed} failed to upload`);
    // The rows stay while anything failed, so the reason can be read. A clean run clears
    // itself — the posters themselves are the confirmation.
    if (!failed) setQueue([]);
  };

  /* Dropping files on it, which is the half that was missing.
   *
   * The album manager takes a drop, so an editor who has added photographs once expects
   * this to as well — and a drop onto a page with no handler is swallowed by the browser,
   * which is indistinguishable from a control that does not work. */
  const onDrop = (e) => {
    e.preventDefault();
    setOver(false);
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) upload(files);
  };

  const addByUrl = () => {
    const u = url.trim();
    if (!u) return;
    append([u]);
    setUrl("");
  };

  const remove = (i) => {
    const gone = posters[i];
    const next = posters.filter((_, j) => j !== i);
    onChange(next);
    /* Removing the main artwork promotes the next one rather than leaving the event with
       a collection and nothing standing for it — a card with no picture is a worse
       outcome than a main piece the editor did not personally choose. */
    if (gone === main) onMainChange(next[0] || "");
  };

  const move = (i, to) => {
    if (to < 0 || to >= posters.length) return;
    const next = [...posters];
    const [held] = next.splice(i, 1);
    next.splice(to, 0, held);
    onChange(next);
  };

  return (
    <div data-testid={testId}>
      <div className="text-[10px] text-ink-4 mb-1 font-mono-x uppercase tracking-[0.2em]">{label}</div>

      {/* The album manager's dropzone, in the event dialog. Same shape, same words, same
          pipeline — an editor who has filled a gallery already knows how this works, and
          the previous control (a lone "Upload" button beside a URL box) took no drop at
          all, so the gesture they had learned did nothing here. */}
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        data-testid={`${testId}-dropzone`}
        className={`border border-dashed p-6 text-center cursor-pointer transition-colors ${
          over ? "border-brand bg-ink/[0.04]" : "border-ink/25 hover:border-ink/50"
        }`}
      >
        <div className="font-mono-x text-xs uppercase tracking-[0.2em] text-ink-2">
          {busy > 0 ? `Uploading ${busy}…` : "Drop posters here, or click to choose"}
        </div>
        <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 mt-1">
          JPEG, PNG, WebP, GIF · resized here before sending · first one becomes the main artwork
        </div>
        {/* Several at once: artwork arrives as a set — a poster, a square crop for the
            socials, the flyer back — and one-at-a-time is the same job done four times. */}
        <input ref={inputRef} type="file" accept="image/*" multiple className="hidden"
               data-testid={`${testId}-file`}
               /* COPY the list before clearing the input, which is not a style choice.
                  `e.target.files` is live: resetting `value` — done so that choosing the
                  same file twice in a row still fires a change — empties that very
                  object. Held by reference, the picked file was gone by the next line and
                  the upload silently did nothing, which is exactly what "I clicked upload
                  and chose a file and nothing happened" was. The album manager spreads
                  first and has always worked; this is the same line.

                  jsdom does not empty `files` on reset, so no test could see it until one
                  emulated the browser — see PosterField.test.jsx. */
               onChange={(e) => { const f = [...(e.target.files || [])]; e.target.value = ""; if (f.length) upload(f); }} />
      </div>

      {/* Outside the dropzone, or clicking the field would open the file picker — the
          same reason the album manager keeps its URL box below rather than inside. */}
      <div className="mt-2 flex flex-wrap gap-2">
        <input placeholder="…or paste an image URL"
               value={url}
               onChange={(e) => setUrl(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addByUrl(); } }}
               className="input-x flex-1 min-w-[12rem] !text-xs" data-testid={`${testId}-url`} />
        {url.trim() && (
          <button type="button" onClick={addByUrl}
                  className="btn-primary shrink-0" data-testid={`${testId}-add-url`}>Add</button>
        )}
      </div>

      {queue.length > 0 && (
        <div className="mt-3 border border-ink/10" data-testid={`${testId}-queue`}>
          <div className="divide-y divide-ink/10">
            {queue.map((q) => (
              <div key={q.key}
                   className="flex items-center justify-between gap-3 px-3 py-1.5 font-mono-x text-[10px] uppercase tracking-[0.15em]">
                <span className="truncate text-ink-3">{q.name}</span>
                <span className={
                  q.stage === STAGE.DONE ? "text-ok shrink-0"
                  : q.stage === STAGE.FAILED ? "text-brand shrink-0"
                  : "text-ink-4 shrink-0"
                } data-testid={`${testId}-stage-${q.key}`}>
                  {stageLabel(q)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {posters.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-3" data-testid={`${testId}-strip`}>
          {posters.map((src, i) => {
            const isMain = src === main;
            return (
              <div key={`${src}-${i}`} data-testid={`${testId}-tile-${i}`}
                   data-main={isMain ? "true" : "false"}
                   className={`relative w-28 border ${isMain ? "border-brand" : "border-ink/15"}`}>
                <img src={mediaUrl(src)} alt="" className="h-20 w-full object-cover" />
                {isMain && (
                  <div className="absolute top-0 left-0 bg-brand text-brand-fg font-mono-x text-[9px] uppercase tracking-[0.2em] px-1.5 py-0.5">
                    Main
                  </div>
                )}
                <div className="flex items-center justify-between gap-1 px-1 py-1">
                  <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0}
                          title="Move earlier" data-testid={`${testId}-left-${i}`}
                          className="font-mono-x text-[11px] text-ink-4 hover:text-ink disabled:opacity-30">←</button>
                  {/* Nominating the main artwork is one click on the piece itself, not a
                      dropdown listing filenames an editor would have to recognise. */}
                  <button type="button" onClick={() => onMainChange(src)} disabled={isMain}
                          title="Use as main artwork" data-testid={`${testId}-main-${i}`}
                          className={`font-mono-x text-[11px] ${isMain ? "text-brand" : "text-ink-4 hover:text-ink"}`}>★</button>
                  <button type="button" onClick={() => remove(i)}
                          title="Remove" data-testid={`${testId}-remove-${i}`}
                          className="font-mono-x text-[11px] text-ink-4 hover:text-brand">×</button>
                  <button type="button" onClick={() => move(i, i + 1)} disabled={i === posters.length - 1}
                          title="Move later" data-testid={`${testId}-right-${i}`}
                          className="font-mono-x text-[11px] text-ink-4 hover:text-ink disabled:opacity-30">→</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
