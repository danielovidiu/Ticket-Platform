import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { http } from "../api";
import { mediaUrl } from "../lib/media";
import { useSingleUpload } from "../lib/useUpload";

const ACCEPT = { prefix: "image/", message: "Choose an image — videos belong in the album below" };

/**
 * One image slot, filled either way: paste a URL from somewhere else, or upload a file
 * straight from the machine. An upload goes through the same /admin/uploads endpoint the
 * album manager uses and stores the returned path in the same `image_url` field — a
 * pasted URL and an uploaded file are indistinguishable to everything downstream.
 *
 * It also goes through the same pipeline: downscaled here first, because the deployed
 * function refuses a request body a full-size phone photo exceeds, and retried when the
 * failure is one that retrying can fix.
 */
export default function ImageField({ value, onChange, label = "Image", testId = "image-field" }) {
  const inputRef = useRef(null);
  const [broken, setBroken] = useState(false);

  const send = useCallback(async (file) => {
    const fd = new FormData();
    fd.append("file", file);
    const { data } = await http.post("/admin/uploads", fd);
    return data;
  }, []);

  const onDone = useCallback((data) => {
    setBroken(false);
    onChange(data.url);
    toast.success("Image uploaded");
  }, [onChange]);

  const upload = useSingleUpload({ send, onDone, accept: ACCEPT });

  return (
    <div data-testid={testId}>
      <div className="text-[10px] text-ink-4 mb-1 font-mono-x uppercase tracking-[0.2em]">{label}</div>
      <div className="flex flex-wrap gap-2">
        <input
          placeholder="Paste an image URL, or upload →"
          value={value || ""}
          onChange={(e) => { setBroken(false); onChange(e.target.value); }}
          className="input-x flex-1 min-w-[12rem]"
          data-testid={`${testId}-url`}
        />
        <button type="button" onClick={() => inputRef.current?.click()} disabled={upload.busy}
                className="btn-primary shrink-0 disabled:opacity-40" data-testid={`${testId}-upload`}>
          {upload.busy ? upload.label : "Upload"}
        </button>
        {value && (
          <button type="button" onClick={() => { setBroken(false); onChange(""); }}
                  className="btn-primary shrink-0" data-testid={`${testId}-clear`}>Clear</button>
        )}
        <input ref={inputRef} type="file" accept="image/*" className="hidden" data-testid={`${testId}-file`}
               onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; upload.start(f); }} />
      </div>

      {/* An upload that failed says what happened and offers the file back, rather than
          a toast that is gone by the time anyone reads it. */}
      {upload.error && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border border-brand px-3 py-2"
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

      {value && !broken && (
        <img src={mediaUrl(value)} alt="" onError={() => setBroken(true)}
             className="mt-2 h-28 w-auto max-w-full object-cover border border-ink/10" data-testid={`${testId}-preview`} />
      )}
      {value && broken && (
        // A pasted URL that doesn't load is worth saying out loud — otherwise it only
        // shows up as an empty box on the live event page.
        <div className="mt-2 border border-brand px-3 py-2 font-mono-x text-[10px] uppercase tracking-[0.2em] text-brand">
          This URL didn't load
        </div>
      )}
    </div>
  );
}
