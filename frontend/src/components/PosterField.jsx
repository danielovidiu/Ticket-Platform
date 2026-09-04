import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { http } from "../api";
import { mediaUrl } from "../lib/media";
import { runPipeline } from "../lib/uploadPipeline";

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
  const posters = Array.isArray(value) ? value : [];

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
    const results = await runPipeline(picked, { send });
    setBusy(0);
    const ok = results.filter((r) => r?.ok).map((r) => r.data.url);
    const failed = results.length - ok.length;
    append(ok);
    if (ok.length) toast.success(`${ok.length} poster${ok.length === 1 ? "" : "s"} added`);
    if (failed) toast.error(`${failed} failed to upload`);
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

      <div className="flex flex-wrap gap-2">
        <input placeholder="Paste an image URL, or upload →"
               value={url}
               onChange={(e) => setUrl(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addByUrl(); } }}
               className="input-x flex-1 min-w-[12rem]" data-testid={`${testId}-url`} />
        {url.trim() && (
          <button type="button" onClick={addByUrl}
                  className="btn-primary shrink-0" data-testid={`${testId}-add-url`}>Add</button>
        )}
        <button type="button" onClick={() => inputRef.current?.click()} disabled={busy > 0}
                className="btn-primary shrink-0 disabled:opacity-40" data-testid={`${testId}-upload`}>
          {busy > 0 ? `Uploading ${busy}…` : "Upload"}
        </button>
        {/* Several at once: artwork arrives as a set — a poster, a square crop for the
            socials, the flyer back — and one-at-a-time is the same job done four times. */}
        <input ref={inputRef} type="file" accept="image/*" multiple className="hidden"
               data-testid={`${testId}-file`}
               onChange={(e) => { const f = e.target.files; e.target.value = ""; if (f?.length) upload(f); }} />
      </div>

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
