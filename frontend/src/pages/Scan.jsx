import React, { useRef, useState } from "react";
import { http } from "../api";
import { useAuth, startLogin } from "../auth";
import { Check, X, Camera, Zap, ZapOff } from "lucide-react";
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

  const handleStart = async () => {
    setResult(null);
    setCameraError(null);
    const r = await start();
    if (r?.error) setCameraError(r.error);
  };

  if (loading) return <div className="p-16 text-center font-mono-x text-zinc-500">Loading…</div>;
  if (!user) return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-black p-6">
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
    <div className="min-h-screen bg-black text-white">
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
                   ? "w-full max-h-[45vh] object-cover bg-black mt-4 border border-current"
                   : "hidden"} />
          {!scanning ? (
            <button onClick={handleStart} data-testid="start-camera" className="btn-accent w-full mt-4"><Camera className="inline mr-2" size={16} /> START SCANNER</button>
          ) : (
            <div className="flex gap-2 mt-2">
              <button onClick={stop} data-testid="stop-camera" className="btn-primary flex-1">STOP</button>
              {torchSupported && (
                <button onClick={toggleTorch} data-testid="toggle-torch"
                        aria-pressed={torchOn}
                        className={`btn-primary flex-1 ${torchOn ? "!bg-white !text-black" : ""}`}>
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
      {result && <ScanResult result={result} onNext={nextTicket} />}
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
function ScanResult({ result, onNext }) {
  const tone = result.valid
    ? "bg-[color:var(--success)] text-black"
    : "bg-[color:var(--accent)] text-white";
  return (
    <div role="alertdialog" aria-live="assertive" data-testid="scan-result"
         className={`fixed inset-0 z-50 ${tone} flex flex-col items-center justify-center text-center p-6 overflow-y-auto`}>
      {result.valid ? (
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
      {/* Full width and thumb-sized: this is pressed once per guest, often one-handed. */}
      <button onClick={onNext} autoFocus data-testid="next-ticket"
              className="border-2 border-current w-full max-w-sm px-6 py-5 mt-10 font-mono-x uppercase tracking-[0.2em] text-base font-bold">
        NEXT TICKET
      </button>
      <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] mt-3 opacity-70">
        Scanning is paused until you continue
      </div>
    </div>
  );
}
