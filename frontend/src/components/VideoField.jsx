import { useCallback, useRef } from "react";
import { toast } from "sonner";
import { mediaUrl } from "../lib/media";
import { uploadVideo } from "../lib/uploadVideo";
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
 * A video is never resized: a browser cannot transcode one. A clip over the deployment's
 * ceiling is refused with the number it exceeded rather than retried on its way to the
 * same answer.
 *
 * The file may not go through the API at all. See lib/uploadVideo — on a platform that
 * refuses a body over ~4.5MB, the browser sends it straight to blob storage instead, and
 * only the poster frame comes this way.
 */
export default function VideoField({
  value, posterValue, onPatch, label = "Video file", testId = "video-field",
  // Which props this field writes. Defaulted so every existing call site is unchanged,
  // and overridable so the same control can carry a second, mobile cut of the same video.
  fileKey = "file_url", posterKey = "poster_url",
}) {
  const inputRef = useRef(null);

  // Which route the file takes is `uploadVideo`'s decision, not this component's: on
  // Vercel a video has to go straight to blob storage because the platform will not carry
  // a body that size, and everywhere else it goes through the API as it always has.
  //
  // `opts` carries the progress reporter. Only the direct route calls it — the API route
  // has no way to measure a request it hands to the browser whole — so the readout below
  // is written to be correct when there is no number at all.
  const send = useCallback((file, opts) => uploadVideo(file, opts), []);

  const onDone = useCallback(({ url, poster_url }) => {
    onPatch({ [fileKey]: url, [posterKey]: poster_url || "" });
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

      {/* The uploading status, under the controls rather than only inside the button.
          A video is the one upload here that can take long enough for "is this doing
          anything?" to be a real question, and now that it goes straight to blob storage
          there is a true byte count to answer it with.

          The bar is drawn only when there is a number. On the API route there is none,
          and a bar with nothing in it — or worse, one that animates without meaning —
          would be a claim the code cannot support. In that case the word alone is shown. */}
      {upload.busy && (
        <div className="mt-2 border border-ink/10 px-3 py-2" data-testid={`${testId}-status`}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-3">
              {upload.label}
            </span>
            {upload.progress != null && (
              <span className="font-mono-x text-[10px] tracking-[0.2em] text-ink-3 tabular-nums"
                    data-testid={`${testId}-percent`}>{upload.progress}%</span>
            )}
          </div>
          {upload.progress != null && (
            <div className="mt-2 h-[2px] w-full bg-ink/10" data-testid={`${testId}-bar`}>
              <div className="h-full bg-ink transition-[width] duration-200"
                   style={{ width: `${upload.progress}%` }} />
            </div>
          )}
        </div>
      )}

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
