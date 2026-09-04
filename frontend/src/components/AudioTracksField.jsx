import { useCallback, useRef } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { mediaUrl } from "../lib/media";
import { uploadAudio } from "../lib/uploadAudio";
import { useSingleUpload } from "../lib/useUpload";
import { AUDIO_TRACK_MAX_SECONDS, fmtClock } from "./blocks";

const ACCEPT = { prefix: "audio/", message: "Choose an audio file — MP3, WAV, OGG or M4A" };

/**
 * One row: a name and a clip.
 *
 * Its own component because of the upload hook. `useSingleUpload` holds the state of one
 * transfer, and hooks cannot be called in a loop — so a list of uploads is a list of
 * components, one hook each, rather than one hook trying to track several files at once.
 */
function TrackRow({ track, index, count, onPatch, onRemove, onMove, testId }) {
  const inputRef = useRef(null);

  const send = useCallback((file, opts) => uploadAudio(file, opts), []);
  const onDone = useCallback(({ url }) => {
    // The length goes with the file. Left in place, the row would print the previous
    // clip's number for the moment between the upload landing and the new metadata
    // arriving — and indefinitely, if the new file has no readable length.
    onPatch({ url, duration: 0 });
    toast.success("Clip uploaded");
  }, [onPatch]);

  const upload = useSingleUpload({ send, onDone, accept: ACCEPT });

  return (
    <li className="border border-ink/10 p-2 space-y-2" data-testid={testId}>
      <div className="flex items-center gap-2">
        <span className="font-mono-x text-[10px] tracking-[0.2em] text-ink-5 tabular-nums w-5 shrink-0">
          {String(index + 1).padStart(2, "0")}
        </span>
        <input
          value={track.title || ""}
          placeholder="Track name"
          aria-label={`Track ${index + 1} name`}
          onChange={(e) => onPatch({ title: e.target.value })}
          autoCapitalize="off" autoCorrect="off" autoComplete="off"
          className="input-x flex-1 min-w-0 !py-1.5 !text-xs"
          data-testid={`${testId}-title`}
        />
        {/* Order is the play order, so it has to be editable — autoplay steps down this
            list and there is nowhere else that decides what comes next. */}
        <button type="button" onClick={() => onMove(-1)} disabled={index === 0}
                aria-label="Move up" data-testid={`${testId}-up`}
                className="shrink-0 p-1 text-ink-4 hover:text-ink disabled:opacity-25"><ChevronUp size={13} /></button>
        <button type="button" onClick={() => onMove(1)} disabled={index === count - 1}
                aria-label="Move down" data-testid={`${testId}-down`}
                className="shrink-0 p-1 text-ink-4 hover:text-ink disabled:opacity-25"><ChevronDown size={13} /></button>
        <button type="button" onClick={onRemove} aria-label="Remove track" data-testid={`${testId}-remove`}
                className="shrink-0 p-1 text-ink-4 hover:text-brand"><Trash2 size={13} /></button>
      </div>

      {/* What was measured, and what the block will actually play of it. Shown because it
          is otherwise invisible state: it is read from the file rather than typed, it is
          what the public list prints, and a clip over the cap is worth seeing here rather
          than discovering by listening to it stop. */}
      {track.duration > 0 && (
        <div className="flex items-center gap-2 pl-7 font-mono-x text-[10px] tracking-[0.2em] text-ink-5"
             data-testid={`${testId}-duration`}>
          <span className="tabular-nums">{fmtClock(track.duration)}</span>
          {track.duration > AUDIO_TRACK_MAX_SECONDS && (
            <span className="text-brand uppercase" data-testid={`${testId}-over-cap`}>
              over {AUDIO_TRACK_MAX_SECONDS}s — plays the first {fmtClock(AUDIO_TRACK_MAX_SECONDS)}
            </span>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <input
          value={track.url || ""}
          placeholder="Paste an audio URL, or upload →"
          aria-label={`Track ${index + 1} file`}
          // Same reason as the upload: a different URL is a different clip, so the length
          // measured from the last one has to go with it.
          onChange={(e) => onPatch({ url: e.target.value, duration: 0 })}
          autoCapitalize="off" autoCorrect="off" autoComplete="off"
          className="input-x flex-1 min-w-[10rem] !py-1.5 !text-xs"
          data-testid={`${testId}-url`}
        />
        <button type="button" onClick={() => inputRef.current?.click()} disabled={upload.busy}
                className="btn-primary shrink-0 !py-1.5 !px-2 !text-[10px] disabled:opacity-40"
                data-testid={`${testId}-upload`}>
          {upload.busy ? upload.label : "Upload"}
        </button>
        <input ref={inputRef} type="file" className="hidden"
               // Every type the server takes, including the `x-` spellings some browsers
               // report — this attribute filters the picker, so a name missing here is a
               // file the editor cannot even select.
               accept="audio/mpeg,audio/wav,audio/x-wav,audio/ogg,audio/mp4,audio/x-m4a,audio/aac"
               data-testid={`${testId}-file`}
               onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; upload.start(f); }} />
      </div>

      {upload.error && (
        <div className="flex flex-wrap items-center justify-between gap-2 border border-brand px-2 py-1"
             data-testid={`${testId}-error`}>
          <span className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-brand">{upload.error}</span>
          <span className="flex gap-2 shrink-0">
            {upload.canRetry && (
              <button type="button" onClick={upload.retry} disabled={upload.busy}
                      className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-3 hover:text-ink disabled:opacity-40"
                      data-testid={`${testId}-retry`}>Retry</button>
            )}
            <button type="button" onClick={upload.dismiss}
                    className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 hover:text-ink"
                    data-testid={`${testId}-dismiss`}>Dismiss</button>
          </span>
        </div>
      )}

      {/* The browser's own player, not the block's. This is for checking that the right
          file landed in the right row; what a visitor gets is the block's player. */}
      {/* `preload="metadata"` HERE and nowhere else, which is the whole point of reading
          the length at this end.

          The block shows every track's length in its list, the way a record shop's player
          does. Asking the browser for that on the public page would mean a request per
          track on every visit, for a number that cannot change once the file is uploaded —
          and this file already argues the opposite case for the video block's two cuts.

          So it is measured once, by whoever is choosing the clip, and stored beside the
          URL. The same trade the video poster makes: captured in the browser at authoring
          time because there is no transcoder on the server to ask. */}
      {track.url && (
        <audio src={mediaUrl(track.url)} controls preload="metadata"
               onLoadedMetadata={(e) => {
                 const seconds = e.currentTarget.duration;
                 if (!Number.isFinite(seconds)) return;          // a stream has no length
                 const known = Math.round(seconds);
                 if (known !== track.duration) onPatch({ duration: known });
               }}
               className="w-full h-8" data-testid={`${testId}-preview`} />
      )}
    </li>
  );
}

/**
 * The list of clips a Split + Audio block plays, in the order it plays them.
 *
 * Rows rather than a text box — unlike the marquee's list, an item here is two things
 * (a name and a file) and one of them arrives by upload, so there is nothing to type.
 *
 * Nothing enforces the ninety seconds at this end. Trimming audio needs a transcoder and
 * there isn't one on the server; the player stops at ninety and moves on regardless of
 * what was uploaded, and the note below says so rather than letting an editor discover it
 * by listening.
 */
export default function AudioTracksField({ value, onChange, label = "Audio tracks", testId = "audio-tracks" }) {
  const tracks = Array.isArray(value) ? value : [];

  const patch = (index, part) =>
    onChange(tracks.map((t, i) => (i === index ? { ...t, ...part } : t)));

  const move = (index, by) => {
    const to = index + by;
    if (to < 0 || to >= tracks.length) return;
    const next = [...tracks];
    [next[index], next[to]] = [next[to], next[index]];
    onChange(next);
  };

  return (
    <div data-testid={testId}>
      <div className="text-[10px] text-ink-4 mb-1 font-mono-x uppercase tracking-[0.2em]">{label}</div>
      <ul className="space-y-2">
        {tracks.map((track, i) => (
          <TrackRow
            key={i}
            track={track}
            index={i}
            count={tracks.length}
            testId={`${testId}-${i}`}
            onPatch={(part) => patch(i, part)}
            onRemove={() => onChange(tracks.filter((_, at) => at !== i))}
            onMove={(by) => move(i, by)}
          />
        ))}
      </ul>
      <button type="button" onClick={() => onChange([...tracks, { title: "", url: "" }])}
              className="btn-primary w-full mt-2 !py-1.5 !text-[10px]" data-testid={`${testId}-add`}>
        <Plus size={11} className="inline mr-1" /> Add track
      </button>
      <p className="mt-2 text-[10px] leading-relaxed text-ink-4 border-l border-ink/20 pl-2">
        Snippets, not full tracks — the player stops each one at {AUDIO_TRACK_MAX_SECONDS} seconds and
        starts the next.
      </p>
    </div>
  );
}
