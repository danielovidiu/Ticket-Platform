import React, { useRef, useState } from "react";
import { http } from "../api";
import { useAuth, startLogin } from "../auth";
import { Check, X, Ban, Camera, Zap, ZapOff } from "lucide-react";
import { useOfflineScanQueue, useQrCamera } from "../hooks/useScanner";

export default function Scan() {
  const { user, loading } = useAuth();
  const [manual, setManual] = useState("");
  const [result, setResult] = useState(null);
  // Kept apart from `result` on purpose. `result` is a verdict on a ticket and paints the
  // whole screen red for INVALID; a camera that won't open is not a bad ticket, and
  // showing "INVALID" for it told door staff the guest should be turned away.
  const [cameraError, setCameraError] = useState(null);
  const { enqueue } = useOfflineScanQueue();

  const submit = async (code) => {
    if (!code) return;
    setManual("");
    // Freeze the loop the moment a code lands. The verdict owns the screen until it is
    // dismissed, and a ticket still held up to the lens must not scan itself again.
    pauseRef.current?.();
    if (!navigator.onLine) {
      enqueue(code);
      setResult({ valid: true, reason: "QUEUED OFFLINE", offline: true });
      return;
    }
    try {
      const { data } = await http.post("/scan", { qr_code: code });
      setResult(data);
    } catch (e) {
      setResult({ valid: false, reason: e.response?.data?.detail || "ERROR" });
    }
  };

  const { videoRef, scanning, start, stop, pause, resume,
          torchSupported, torchOn, toggleTorch } = useQrCamera(submit);
  // submit is defined before the hook that supplies pause(); a ref bridges the two.
  const pauseRef = useRef(null);
  pauseRef.current = pause;

  /** Clear the verdict and hand the lens to the next guest. */
  const nextTicket = () => {
    setResult(null);
    resume();
  };

  /**
   * Turn this guest away. Returns { error } rather than throwing so the overlay can show
   * the reason in place — a door decision that half-worked must say so on the screen
   * someone is already looking at.
   */
  const deny = async (reason) => {
    // Scans queue offline; denials deliberately do not. A denial that silently vanished
    // into a queue would tell staff the person was denied when they were not, and the
    // ticket would still read `used` in the morning.
    if (!navigator.onLine) return { error: "NO CONNECTION — DENIAL NOT RECORDED" };
    try {
      const { data } = await http.post("/scan/deny", {
        qr_code: result?.ticket?.qr_code, reason,
      });
      if (!data.ok) return { error: data.reason || "COULD NOT DENY" };
      setResult({ ...result, valid: false, denied: true, ticket: data.ticket });
      return {};
    } catch (e) {
      return { error: e.response?.data?.detail || "ERROR" };
    }
  };

  const handleStart = async () => {
    setResult(null);
    setCameraError(null);
    const r = await start();
    if (r?.error) setCameraError(r.error);
  };

  if (loading) return <div className="p-16 text-center font-mono-x text-ink-4">Loading…</div>;
  if (!user) return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-page p-6">
      <div className="font-display text-3xl uppercase font-black">DOOR SCANNER</div>
      <button onClick={() => startLogin("/scan")} className="btn-accent mt-6">SIGN IN</button>
    </div>
  );
  if (user.role !== "admin" && user.role !== "door") {
    return <div className="min-h-screen flex items-center justify-center text-center p-6">Access denied. Contact admin for door role.</div>;
  }

  // The verdict overlay carries its own colour now, so the page underneath stays neutral.
  // Recolouring both meant dismissing a result had to unwind two things to get back to a
  // clean scanning screen.
  return (
    <div className="min-h-screen bg-page text-ink">
      <div className="p-4 flex justify-between items-center hairline-b">
        <div className="font-display text-xl uppercase font-black">DOOR · {user.role.toUpperCase()}</div>
        <div className="font-mono-x text-[10px] uppercase tracking-[0.3em]">{user.email}</div>
      </div>

      <div className="p-4 md:p-8 max-w-2xl mx-auto space-y-6">
        <div className="border-2 border-current p-6">
          <div className="font-mono-x text-xs uppercase tracking-[0.3em]">Camera</div>
          {/* The <video> stays mounted and is hidden while idle, rather than being
              rendered only when scanning. start() needs a real element to attach the
              stream to, and it runs before React would have created one. */}
          {/* autoplay as well as muted + playsInline: iOS will refuse to start an
              inline stream without all three, and playsInline alone leaves the frame
              pipeline idle until something calls play().

              max-h caps the preview. A phone camera in portrait is around 720x1280, and
              at w-full that pushed STOP off the bottom of the screen. Cropping the
              display costs nothing: the decoder reads the video element's own frames,
              not the box it is drawn in. */}
          <video ref={videoRef} autoPlay muted playsInline
                 data-testid="scanner-video"
                 className={scanning
                   /* scrim: this is the letterbox behind the camera feed, and a
                      viewfinder matting stays black whatever the site theme is. */
                   ? "w-full max-h-[45vh] object-cover bg-scrim mt-4 border border-current"
                   : "hidden"} />
          {!scanning ? (
            <button onClick={handleStart} data-testid="start-camera" className="btn-accent w-full mt-4"><Camera className="inline mr-2" size={16} /> START SCANNER</button>
          ) : (
            <div className="flex gap-2 mt-2">
              <button onClick={stop} data-testid="stop-camera" className="btn-primary flex-1">STOP</button>
              {torchSupported && (
                <button onClick={toggleTorch} data-testid="toggle-torch"
                        aria-pressed={torchOn}
                        className={`btn-primary flex-1 ${torchOn ? "!bg-ink !text-page" : ""}`}>
                  {torchOn ? <Zap className="inline mr-2" size={14} /> : <ZapOff className="inline mr-2" size={14} />}
                  FLASH
                </button>
              )}
            </div>
          )}
          {cameraError && (
            <div data-testid="camera-error"
                 className="mt-4 border border-current/40 p-3 font-mono-x text-[11px] uppercase tracking-[0.15em] leading-relaxed opacity-80">
              {cameraError}
              <div className="mt-1 opacity-70">Enter the code by hand below.</div>
            </div>
          )}
        </div>

        <div className="border-2 border-current p-6">
          <div className="font-mono-x text-xs uppercase tracking-[0.3em]">Manual code</div>
          <form onSubmit={(e) => { e.preventDefault(); submit(manual.trim()); }}>
            <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="SNTY-XXXXXXX" data-testid="manual-code-input"
                   className="w-full bg-transparent border-2 border-current p-4 font-mono-x uppercase text-lg mt-3 outline-none" />
            <button data-testid="scan-submit" className="btn-accent w-full mt-3">SCAN</button>
          </form>
        </div>

      </div>

      {/* Outside the space-y-6 column on purpose: that utility puts a top margin on every
          child after the first, and a margin still displaces a position:fixed element —
          it sat 24px low and hung off the bottom of the screen. */}
      {result && <ScanResult result={result} onNext={nextTicket} onDeny={deny} />}
    </div>
  );
}

/**
 * The verdict, over everything else.
 *
 * It used to render inline at the bottom of the page, below the camera and the manual
 * form — so on a phone the green screen appeared with its dismiss button somewhere off
 * the bottom, and there was no obvious way to move on to the next guest. A door verdict
 * is a modal decision: it owns the screen until someone acts on it, and the only action
 * is always in reach.
 */
// Exported for its tests. The rest of this page needs a camera, a session and a network;
// the verdict overlay needs none of those, and it is the part where a wrong render costs
// somebody their entry — so it is the part worth testing directly.
export function ScanResult({ result, onNext, onDeny }) {
  // Asking for a reason inline rather than through confirm() + prompt(): two native
  // dialogs in a row on a phone, at a door, in the dark, is the worst version of this.
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // A denial is not a bad ticket, so it gets its own verdict rather than reusing INVALID
  // — staff need to see that the decision they just made is the one that landed.
  const tone = result.denied ? "bg-ink text-page"
    : result.valid ? "bg-ok text-page"
    : "bg-brand text-ink";

  const confirmDeny = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await onDeny(reason.trim());
    setBusy(false);
    if (err) setError(err);
    else setDenying(false);
  };

  return (
    <div role="alertdialog" aria-live="assertive" data-testid="scan-result"
         className={`fixed inset-0 z-50 ${tone} flex flex-col items-center justify-center text-center p-6 overflow-y-auto`}>
      {result.denied ? (
        <>
          <Ban size={96} className="shrink-0" />
          <div className="font-display text-5xl sm:text-7xl uppercase font-black tracking-tighter mt-4">DENIED</div>
          <div className="font-mono-x uppercase mt-2 text-lg break-words max-w-full">ENTRY REFUSED</div>
          {result.ticket?.deny_reason && (
            <div className="font-mono-x text-xs mt-2 opacity-80 break-words max-w-full">{result.ticket.deny_reason}</div>
          )}
        </>
      ) : result.valid ? (
        <>
          <Check size={96} className="shrink-0" />
          <div className="font-display text-5xl sm:text-7xl uppercase font-black tracking-tighter mt-4">VALID</div>
          {result.event && <div className="font-mono-x uppercase mt-2 break-words max-w-full">{result.event.title}</div>}
          {result.offline && <div className="font-mono-x text-xs mt-2 opacity-70">QUEUED — WILL SYNC WHEN ONLINE</div>}
        </>
      ) : (
        <>
          <X size={96} className="shrink-0" />
          <div className="font-display text-5xl sm:text-7xl uppercase font-black tracking-tighter mt-4">INVALID</div>
          <div className="font-mono-x uppercase mt-2 text-lg break-words max-w-full">{result.reason}</div>
        </>
      )}

      {denying ? (
        <div className="w-full max-w-sm mt-8" data-testid="deny-panel">
          <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] opacity-80">Reason (optional)</div>
          <input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus
                 data-testid="deny-reason" maxLength={200}
                 placeholder="No ID, refused search…"
                 className="w-full bg-transparent border-2 border-current p-3 font-mono-x uppercase text-sm mt-2 outline-none placeholder:opacity-50" />
          {error && (
            <div data-testid="deny-error"
                 className="mt-3 border border-current/40 p-2 font-mono-x text-[11px] uppercase tracking-[0.15em]">
              {error}
            </div>
          )}
          <button onClick={confirmDeny} disabled={busy} data-testid="deny-confirm"
                  className="border-2 border-current w-full px-6 py-5 mt-3 font-mono-x uppercase tracking-[0.2em] text-base font-bold disabled:opacity-50">
            {busy ? "DENYING…" : "CONFIRM DENIAL"}
          </button>
          <button onClick={() => { setDenying(false); setError(null); }} disabled={busy}
                  data-testid="deny-cancel"
                  className="w-full px-6 py-3 mt-2 font-mono-x uppercase tracking-[0.2em] text-xs opacity-80">
            KEEP ADMITTED
          </button>
        </div>
      ) : (
        <>
          {/* Full width and thumb-sized: this is pressed once per guest, often one-handed. */}
          <button onClick={onNext} autoFocus data-testid="next-ticket"
                  className="border-2 border-current w-full max-w-sm px-6 py-5 mt-10 font-mono-x uppercase tracking-[0.2em] text-base font-bold">
            NEXT TICKET
          </button>
          {/* Offered only on a valid verdict: this reverses an admission that was just
              granted, so there has to be one to reverse. Secondary by design — the
              common action stays the big one. */}
          {result.valid && !result.offline && (
            <button onClick={() => setDenying(true)} data-testid="deny-entry"
                    className="w-full max-w-sm px-6 py-3 mt-3 border border-current/50 font-mono-x uppercase tracking-[0.2em] text-xs">
              DENY ENTRY
            </button>
          )}
          <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] mt-3 opacity-70">
            Scanning is paused until you continue
          </div>
        </>
      )}
    </div>
  );
}
