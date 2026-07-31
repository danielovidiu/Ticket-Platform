import { useCallback, useEffect, useRef, useState } from "react";
import { http } from "../api";

/**
 * Offline scan queue. Stores QR codes in localStorage while offline and
 * replays them to the backend when the browser is back online.
 *
 * SECURITY NOTE: The queued strings are ticket QR codes, not auth tokens or
 * PII. They are only meaningful when combined with an authenticated staff
 * session (the /api/scan endpoint enforces role=admin|door via httpOnly
 * cookie). Storing them in localStorage on a staff device is intentional
 * and required for the "works even with bad venue signal" requirement.
 */
const OFFLINE_KEY = "supersanity_scan_queue";

export function useOfflineScanQueue() {
  useEffect(() => {
    const flush = async () => {
      const q = JSON.parse(localStorage.getItem(OFFLINE_KEY) || "[]");
      if (q.length === 0) return;
      const remaining = [];
      for (const code of q) {
        try { await http.post("/scan", { qr_code: code }); }
        catch (err) {
          console.warn("Offline flush failed for", code, err?.message || err);
          remaining.push(code);
        }
      }
      localStorage.setItem(OFFLINE_KEY, JSON.stringify(remaining));
    };
    window.addEventListener("online", flush);
    if (navigator.onLine) flush();
    return () => window.removeEventListener("online", flush);
  }, []);

  const enqueue = (code) => {
    const q = JSON.parse(localStorage.getItem(OFFLINE_KEY) || "[]");
    q.push(code);
    localStorage.setItem(OFFLINE_KEY, JSON.stringify(q));
  };

  return { enqueue };
}

/** Longest edge the fallback decoder works on. A QR held up to a phone is legible far
 *  below the sensor's native resolution, and jsQR is pure JS scanning every pixel — at
 *  1080p on a mid-range phone a frame costs more than the interval between frames. */
const FALLBACK_MAX_EDGE = 640;

/**
 * Pick a QR decoder for this browser. Returns `detect(video) -> string | null`.
 *
 * `BarcodeDetector` is hardware-accelerated where it exists, but WebKit has never
 * shipped it — that is every browser on iOS, not just Safari, since they all run on
 * WebKit. The door staff most likely to be holding an iPhone were the ones who could not
 * scan at all, so jsQR backs it up rather than the UI telling them to type ticket codes
 * by hand. It is imported dynamically so browsers with the native API never download it.
 *
 * Presence of BarcodeDetector is not enough on its own: the spec lets an implementation
 * support any subset of formats, so the QR format is checked before it is trusted.
 */
async function makeDetector() {
  if ("BarcodeDetector" in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes("qr_code")) {
        const native = new window.BarcodeDetector({ formats: ["qr_code"] });
        return {
          kind: "native",
          detect: async (video) => (await native.detect(video))?.[0]?.rawValue || null,
        };
      }
    } catch {
      // Malformed or partial implementation — fall through to jsQR.
    }
  }

  const jsQR = (await import("jsqr")).default;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return {
    kind: "jsqr",
    detect: async (video) => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return null; // metadata not in yet
      const scale = Math.min(1, FALLBACK_MAX_EDGE / Math.max(vw, vh));
      canvas.width = Math.round(vw * scale);
      canvas.height = Math.round(vh * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // dontInvert: ticket QRs are always dark-on-light, and trying both doubles the work.
      return jsQR(data, width, height, { inversionAttempts: "dontInvert" })?.data || null;
    },
  };
}

/** How long to wait for the camera to actually deliver a frame before giving up. Phones
 *  routinely take a second or two; a stream that has produced nothing by now is stuck. */
const FRAME_READY_TIMEOUT_MS = 10000;
/** Floor between decode attempts. The loop is driven per-frame, which is 30–60Hz —
 *  far more often than anyone presents a ticket, and jsQR reads every pixel in JS. */
const DECODE_MIN_INTERVAL_MS = 120;

const hasMetadata = (v) => v.readyState >= 1 && v.videoWidth > 0;
const hasFrames = (v) => v.readyState >= 2 && v.videoWidth > 0;

/** Resolve once `ready(video)` holds, reject on timeout.
 *
 * Checks the predicate up front as well as on events: with `autoplay` set, a stream can
 * be playing before there is any chance to attach a listener, and a promise waiting on an
 * event that already fired never settles.
 */
function waitForVideo(video, ready, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (ready(video)) return resolve();
    const events = ["loadedmetadata", "loadeddata", "canplay", "playing", "timeupdate"];
    const finish = (ok) => {
      clearTimeout(timer);
      events.forEach((e) => video.removeEventListener(e, onEvent));
      ok ? resolve() : reject(new Error("VIDEO_TIMEOUT"));
    };
    const onEvent = () => { if (ready(video)) finish(true); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    events.forEach((e) => video.addEventListener(e, onEvent));
  });
}

/** Open the back camera, degrading to whatever the device will give.
 *
 * `facingMode: "environment"` is a preference, not a guarantee — and asking for a
 * resolution alongside it is enough to make some devices refuse outright with
 * OverconstrainedError. So the constraints loosen on each attempt rather than the whole
 * scanner failing on a phone with an unusual camera set. A refusal is not retried:
 * NotAllowedError means the user or a policy said no, and looser constraints cannot
 * change that answer.
 */
async function openCameraStream() {
  const attempts = [
    { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } },
    { video: { facingMode: { ideal: "environment" } } },
    { video: true },
  ];
  let lastErr;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastErr = err;
      if (err?.name === "NotAllowedError" || err?.name === "SecurityError") throw err;
    }
  }
  throw lastErr;
}

function describeCameraError(err) {
  switch (err?.name) {
    case "NotAllowedError":
    case "SecurityError":
      // Also what a `Permissions-Policy: camera=()` header produces — and in that case
      // the browser never prompts, so "denied" looks inexplicable from the device.
      return "CAMERA BLOCKED — CHECK BROWSER PERMISSIONS FOR THIS SITE";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "NO CAMERA FOUND ON THIS DEVICE";
    case "NotReadableError":
    case "TrackStartError":
      return "CAMERA IS IN USE BY ANOTHER APP";
    case "OverconstrainedError":
      return "NO USABLE CAMERA ON THIS DEVICE";
    default:
      return "CAMERA UNAVAILABLE";
  }
}

/** Camera + QR detection. `videoRef` must be attached to an element that stays mounted
 *  for as long as the hook lives — see the note in start(). */
export function useQrCamera(onScan) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const detectorRef = useRef(null);
  const frameHandleRef = useRef(null);
  const usingRvfcRef = useRef(false);
  const runningRef = useRef(false);
  const busyRef = useRef(false);
  const lastDecodeAtRef = useRef(0);
  const lastRef = useRef({ code: "", at: 0 });
  const onScanRef = useRef(onScan);
  const pausedRef = useRef(false);
  const trackRef = useRef(null);
  const [scanning, setScanning] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  // The frame loop closes over onScan once; keep it pointing at the current one.
  useEffect(() => { onScanRef.current = onScan; }, [onScan]);

  const cancelFrame = useCallback(() => {
    if (frameHandleRef.current == null) return;
    const video = videoRef.current;
    if (usingRvfcRef.current && video?.cancelVideoFrameCallback) {
      video.cancelVideoFrameCallback(frameHandleRef.current);
    } else {
      cancelAnimationFrame(frameHandleRef.current);
    }
    frameHandleRef.current = null;
  }, []);

  const stop = useCallback(() => {
    runningRef.current = false;
    busyRef.current = false;
    pausedRef.current = false;
    cancelFrame();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    trackRef.current = null;
    const video = videoRef.current;
    if (video) {
      try { video.pause(); } catch { /* already paused or detached */ }
      video.srcObject = null;
    }
    detectorRef.current = null;
    setScanning(false);
    setTorchSupported(false);
    setTorchOn(false); // the torch dies with the track; don't leave the UI claiming it's lit
  }, [cancelFrame]);

  /** Hold the decode loop without dropping the camera.
   *
   * A verdict stays on screen until someone dismisses it, and the frame loop must not
   * keep reading in the meantime: the same ticket sitting in front of the lens would
   * re-fire the moment the 3s debounce lapsed, replacing the verdict the door staff were
   * still reading. The stream stays live so resuming is instant. */
  const pause = useCallback(() => { pausedRef.current = true; }, []);
  const resume = useCallback(() => {
    // Restart the debounce on the code just handled rather than forgetting it. The guest
    // is often still standing there with the ticket in frame when NEXT is pressed, and
    // clearing the memory made it re-scan itself instantly — the verdict reappeared
    // before anyone could look up. A different ticket still registers immediately.
    lastRef.current = { ...lastRef.current, at: Date.now() };
    pausedRef.current = false;
  }, []);

  /** Torch, where the device exposes it — Android Chrome mostly does, iOS does not. */
  const toggleTorch = useCallback(async () => {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] });
      setTorchOn(next);
    } catch {
      // Some devices advertise the capability and then refuse it. Don't leave the
      // button showing a state the lamp isn't in.
      setTorchOn(false);
      setTorchSupported(false);
    }
  }, [torchOn]);

  /* Frame loop.
   *
   * This used to be setInterval(…, 500). A timer is the wrong clock for video: browsers
   * clamp it hard on a backgrounded tab, it keeps firing at frames the camera has not
   * refreshed, and it drifts out of step with the stream. requestVideoFrameCallback fires
   * exactly once per decoded frame, which is what "wait until the camera produces
   * frames" actually means; requestAnimationFrame is the fallback where it is missing.
   * Both stop on their own when the page is hidden, so a pocketed phone burns nothing.
   */
  const scheduleFrame = useCallback(() => {
    const video = videoRef.current;
    if (!runningRef.current || !video) return;
    if (typeof video.requestVideoFrameCallback === "function") {
      usingRvfcRef.current = true;
      frameHandleRef.current = video.requestVideoFrameCallback((now) => pumpRef.current(now));
    } else {
      usingRvfcRef.current = false;
      frameHandleRef.current = requestAnimationFrame((now) => pumpRef.current(now));
    }
  }, []);

  // pump and scheduleFrame call each other; a ref breaks the definition cycle.
  const pumpRef = useRef(() => {});
  pumpRef.current = async (now) => {
    if (!runningRef.current) return;
    scheduleFrame(); // queue the next frame first, so one bad decode cannot end the loop
    if (pausedRef.current) return; // a verdict is on screen, waiting to be dismissed
    if (busyRef.current) return; // previous decode still running — skip, don't pile up
    if (now - lastDecodeAtRef.current < DECODE_MIN_INTERVAL_MS) return;

    const video = videoRef.current;
    const detector = detectorRef.current;
    if (!video || !detector || !hasFrames(video)) return;

    busyRef.current = true;
    lastDecodeAtRef.current = now;
    try {
      const raw = await detector.detect(video);
      if (raw) {
        const at = Date.now();
        // Debounce identical detections within 3s to avoid double-scans
        if (raw !== lastRef.current.code || at - lastRef.current.at > 3000) {
          lastRef.current = { code: raw, at };
          onScanRef.current(raw);
        }
      }
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        console.debug("QR frame decode skipped:", err?.message || err);
      }
    } finally {
      busyRef.current = false;
    }
  };

  const start = useCallback(async () => {
    // Idempotent: a second press tears the first stream down rather than orphaning its
    // tracks, which on a phone leaves the camera LED on with nothing reading from it.
    stop();

    // getUserMedia is undefined outside a secure context, which is how this fails when
    // someone opens the scanner over http://<lan-ip> to try it on a phone.
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      return { error: "CAMERA NEEDS A SECURE (HTTPS) CONNECTION" };
    }

    // The <video> has to already be in the DOM here. It used to be rendered only while
    // `scanning` was true, and this ran before the flag was set — so the ref was null
    // every time, a guard skipped silently, and the stream was never attached.
    const video = videoRef.current;
    if (!video) return { error: "CAMERA PREVIEW UNAVAILABLE" };

    // Load the decoder before opening the camera: a failed dynamic import should not
    // leave a live stream running behind an error message.
    try {
      detectorRef.current = await makeDetector();
    } catch {
      return { error: "QR DECODER FAILED TO LOAD — CHECK YOUR CONNECTION" };
    }

    let stream;
    try {
      stream = await openCameraStream();
    } catch (err) {
      detectorRef.current = null;
      return { error: describeCameraError(err) };
    }
    streamRef.current = stream;
    trackRef.current = stream.getVideoTracks()[0] || null;
    // getCapabilities is itself absent on some browsers; torch stays hidden there.
    const caps = trackRef.current?.getCapabilities?.();
    setTorchSupported(!!caps && "torch" in caps);
    setTorchOn(false);
    video.srcObject = stream;

    // Reveal the preview before waiting on it. The element is display:none while idle,
    // and a display:none video is not reliably decoded — waiting for frames first would
    // deadlock against the very state that produces them.
    setScanning(true);

    try {
      // play() before the metadata is in can reject; wait for the dimensions first, then
      // for a real frame, so the loop never runs against an empty element.
      await waitForVideo(video, hasMetadata, FRAME_READY_TIMEOUT_MS);
      try {
        await video.play();
      } catch {
        // autoplay may already have started it; the frame wait below is the real test.
      }
      await waitForVideo(video, hasFrames, FRAME_READY_TIMEOUT_MS);
    } catch {
      stop();
      return { error: "CAMERA OPENED BUT SENT NO VIDEO — TRY AGAIN" };
    }

    runningRef.current = true;
    pausedRef.current = false;
    lastDecodeAtRef.current = 0;
    lastRef.current = { code: "", at: 0 };
    scheduleFrame();
    return { ok: true, decoder: detectorRef.current.kind };
  }, [stop, scheduleFrame]);

  useEffect(() => stop, [stop]);

  return { videoRef, scanning, start, stop, pause, resume, torchSupported, torchOn, toggleTorch };
}
