import { useEffect, useRef, useState } from "react";
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

/** Camera + QR detection. `videoRef` must be attached to an element that is mounted for
 *  as long as the hook lives — see the note in start(). */
export function useQrCamera(onScan) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const detectorRef = useRef(null);
  const intervalRef = useRef(null);
  const lastRef = useRef({ code: "", at: 0 });
  const onScanRef = useRef(onScan);
  const [scanning, setScanning] = useState(false);

  // The polling loop closes over onScan once; keep it pointing at the current one.
  useEffect(() => { onScanRef.current = onScan; }, [onScan]);

  const stop = () => {
    setScanning(false);
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  const start = async () => {
    // getUserMedia is undefined outside a secure context, which is how this fails when
    // someone opens the scanner over http://<lan-ip> to try it on a phone.
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      return { error: "CAMERA NEEDS A SECURE (HTTPS) CONNECTION" };
    }
    try {
      detectorRef.current = await makeDetector();
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;

      // The <video> has to already be in the DOM here. It used to be rendered only while
      // `scanning` was true, and this ran before the flag was set — so the ref was null
      // every time, the guard below skipped silently, and the stream was never attached.
      // The camera switched on and the preview stayed blank on every platform.
      const video = videoRef.current;
      if (!video) return { error: "CAMERA PREVIEW UNAVAILABLE" };
      video.srcObject = stream;
      await video.play();

      setScanning(true);
      intervalRef.current = setInterval(async () => {
        if (!videoRef.current || !detectorRef.current) return;
        try {
          const raw = await detectorRef.current.detect(videoRef.current);
          if (!raw) return;
          const now = Date.now();
          // Debounce identical detections within 3s to avoid double-scans
          if (raw !== lastRef.current.code || now - lastRef.current.at > 3000) {
            lastRef.current = { code: raw, at: now };
            onScanRef.current(raw);
          }
        } catch (err) {
          // Decoding can throw on a frame that isn't ready. Log, keep polling.
          if (process.env.NODE_ENV !== "production") {
            console.debug("QR frame decode skipped:", err?.message || err);
          }
        }
      }, 500);
      return { ok: true, decoder: detectorRef.current.kind };
    } catch (err) {
      const name = err?.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        return { error: "CAMERA ACCESS DENIED — ALLOW IT IN YOUR BROWSER SETTINGS" };
      }
      if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        return { error: "NO CAMERA FOUND ON THIS DEVICE" };
      }
      if (name === "NotReadableError") {
        return { error: "CAMERA IS IN USE BY ANOTHER APP" };
      }
      return { error: "CAMERA UNAVAILABLE" };
    }
  };

  useEffect(() => () => stop(), []);

  return { videoRef, scanning, start, stop };
}
