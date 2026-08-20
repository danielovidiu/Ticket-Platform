import { useRef, useState } from "react";
import { toast } from "sonner";
import { http } from "../api";
import { mediaUrl } from "../lib/media";
import { captureVideoPoster } from "../lib/videoPoster";

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
 */
export default function VideoField({ value, posterValue, onPatch, label = "Video file", testId = "video-field" }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);

  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      // A poster is what the block shows before playback starts, and the only thing it
      // shows at all when autoplay is off. Null when the browser cannot decode the file;
      // the upload still goes through, the block just opens on a black frame.
      const poster = await captureVideoPoster(file);
      if (poster) fd.append("poster", poster, "poster.jpg");
      const { data } = await http.post("/admin/uploads", fd);
      if (data.media_type !== "video") {
        toast.error("Choose a video — use the image block for stills");
        return;
      }
      onPatch({ file_url: data.url, poster_url: data.has_poster ? data.thumbnail_url : "" });
      toast.success("Video uploaded");
    } catch (e) {
      const d = e.response?.data?.detail;
      toast.error(typeof d === "string" ? d : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid={testId}>
      <div className="text-[10px] text-ink-4 mb-1 font-mono-x uppercase tracking-[0.2em]">{label}</div>
      <div className="flex flex-wrap gap-2">
        <input
          placeholder="Paste an MP4/WebM URL, or upload →"
          value={value || ""}
          onChange={(e) => onPatch({ file_url: e.target.value })}
          className="input-x flex-1 min-w-[12rem]"
          data-testid={`${testId}-url`}
        />
        <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}
                className="btn-primary shrink-0 disabled:opacity-40" data-testid={`${testId}-upload`}>
          {busy ? "…" : "Upload"}
        </button>
        {value && (
          <button type="button" onClick={() => onPatch({ file_url: "", poster_url: "" })}
                  className="btn-primary shrink-0" data-testid={`${testId}-clear`}>Clear</button>
        )}
        <input ref={inputRef} type="file" accept="video/mp4,video/webm,video/quicktime" className="hidden"
               data-testid={`${testId}-file`}
               onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; upload(f); }} />
      </div>

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
