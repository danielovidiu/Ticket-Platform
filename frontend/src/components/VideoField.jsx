import { useCallback, useRef } from "react";
import { toast } from "sonner";
import { http } from "../api";
import { mediaUrl } from "../lib/media";
import { captureVideoPoster } from "../lib/videoPoster";
import { useSingleUpload } from "../lib/useUpload";

const ACCEPT = { prefix: "video/", message: "Choose a video — use the image block for stills" };

/**
 * One video slot for the CMS video block: paste a URL to a file, or upload one from the
 * machine. Same `/admin/uploads` endpoint the album manager uses, so the same container
 * sniffing and the same size cap apply, and the poster is captured in the browser here
 * too — ffmpeg is deliberately not a server dependency.
 *
 * Distinct from `ImageField`, which refuses videos on purpose. This one refuses images
 * for the mirror reason: an <img> in a <video> src is an empty black box on the page.
 *
 * The upload fills two props at once (the file and its poster), so it commits a patch
 * rather than a single value.
 *
 * It runs through the same pipeline as every other upload, with one thing it cannot do:
 * a video is not resized here, because a browser cannot transcode one. So a clip over
 * the deployed function's body limit fails and says to compress it, rather than being
 * retried twice on its way to the same refusal.
 */
export default function VideoField({
  value, posterValue, onPatch, label = "Video file", testId = "video-field",
  // Which props this field writes. Defaulted so every existing call site is unchanged,
  // and overridable so the same control can carry a second, mobile cut of the same video.
  fileKey = "file_url", posterKey = "poster_url",
}) {
  const inputRef = useRef(null);

  const send = useCallback(async (file) => {
    const fd = new FormData();
    fd.append("file", file);
    // A poster is what the block shows before playback starts, and the only thing it
    // shows at all when autoplay is off. Null when the browser cannot decode the file;
    // the upload still goes through, the block just opens on a black frame.
    const poster = await captureVideoPoster(file);
    if (poster) fd.append("poster", poster, "poster.jpg");
    const { data } = await http.post("/admin/uploads", fd);
    return data;
  }, []);

  const onDone = useCallback((data) => {
    onPatch({ [fileKey]: data.url, [posterKey]: data.has_poster ? data.thumbnail_url : "" });
    toast.success("Video uploaded");
  }, [onPatch, fileKey, posterKey]);

  const upload = useSingleUpload({ send, onDone, accept: ACCEPT });

  return (
    <div data-testid={testId}>
      <div className="text-[10px] text-ink-4 mb-1 font-mono-x uppercase tracking-[0.2em]">{label}</div>
      <div className="flex flex-wrap gap-2">
        <input
          placeholder="Paste an MP4/WebM URL, or upload →"
          value={value || ""}
          onChange={(e) => onPatch({ [fileKey]: e.target.value })}
          className="input-x flex-1 min-w-[12rem]"
          data-testid={`${testId}-url`}
        />
        <button type="button" onClick={() => inputRef.current?.click()} disabled={upload.busy}
                className="btn-primary shrink-0 disabled:opacity-40" data-testid={`${testId}-upload`}>
          {upload.busy ? upload.label : "Upload"}
        </button>
        {value && (
          <button type="button" onClick={() => onPatch({ [fileKey]: "", [posterKey]: "" })}
                  className="btn-primary shrink-0" data-testid={`${testId}-clear`}>Clear</button>
        )}
        <input ref={inputRef} type="file" accept="video/mp4,video/webm,video/quicktime" className="hidden"
               data-testid={`${testId}-file`}
               onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; upload.start(f); }} />
      </div>

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

      {value && (
        <video src={mediaUrl(value)} poster={posterValue ? mediaUrl(posterValue) : undefined}
               muted playsInline preload="metadata" controls
               className="mt-2 h-28 w-auto max-w-full object-cover border border-ink/10"
               data-testid={`${testId}-preview`} />
      )}
      {value && (
        <div className="mt-1 text-[10px] text-ink-4 font-mono-x uppercase tracking-[0.2em]">
          Uploaded file overrides the embed URL
        </div>
      )}
    </div>
  );
}
