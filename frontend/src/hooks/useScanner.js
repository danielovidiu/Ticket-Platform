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
const OFFLINE_KEY = "umbra_scan_queue";

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

/**
 * Camera + QR detection via the browser's native BarcodeDetector API.
 * Falls back gracefully with an explicit error if the browser doesn't
 * support it (Safari <17, older Firefox).
 */
export function useQrCamera(onScan) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const detectorRef = useRef(null);
  const intervalRef = useRef(null);
  const lastRef = useRef({ code: "", at: 0 });
  const [scanning, setScanning] = useState(false);

  const stop = () => {
    setScanning(false);
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const start = async () => {
    if (!("BarcodeDetector" in window)) {
      return { error: "CAMERA SCAN NOT SUPPORTED IN THIS BROWSER — USE MANUAL INPUT" };
    }
    try {
      detectorRef.current = new window.BarcodeDetector({ formats: ["qr_code"] });
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setScanning(true);
      intervalRef.current = setInterval(async () => {
        if (!videoRef.current) return;
        try {
          const codes = await detectorRef.current.detect(videoRef.current);
          if (!codes || codes.length === 0) return;
          const raw = codes[0].rawValue;
          if (!raw) return;
          const now = Date.now();
          // Debounce identical detections within 3s to avoid double-scans
          if (raw !== lastRef.current.code || now - lastRef.current.at > 3000) {
            lastRef.current = { code: raw, at: now };
            onScan(raw);
          }
        } catch (err) {
          // BarcodeDetector.detect() can throw transient errors on frames
          // that aren't yet decoded. Log for diagnostics, keep polling.
          if (process.env.NODE_ENV !== "production") {
            console.debug("QR frame decode skipped:", err?.message || err);
          }
        }
      }, 500);
      return { ok: true };
    } catch (err) {
      return { error: err?.name === "NotAllowedError" ? "CAMERA ACCESS DENIED" : "CAMERA UNAVAILABLE" };
    }
  };

  useEffect(() => () => stop(), []);

  return { videoRef, scanning, start, stop };
}
