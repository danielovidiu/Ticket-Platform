import React, { useState } from "react";
import { http } from "../api";
import { useAuth, startLogin } from "../auth";
import { Check, X, Camera } from "lucide-react";
import { useOfflineScanQueue, useQrCamera } from "../hooks/useScanner";

export default function Scan() {
  const { user, loading } = useAuth();
  const [manual, setManual] = useState("");
  const [result, setResult] = useState(null);
  const { enqueue } = useOfflineScanQueue();

  const submit = async (code) => {
    if (!code) return;
    setManual("");
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

  const { videoRef, scanning, start, stop } = useQrCamera(submit);

  const handleStart = async () => {
    setResult(null);
    const r = await start();
    if (r?.error) setResult({ valid: false, reason: r.error });
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

  const bgClass = result ? (result.valid ? "bg-[color:var(--success)] text-black" : "bg-[color:var(--accent)] text-white") : "bg-black text-white";

  return (
    <div className={`min-h-screen ${bgClass} transition-colors`}>
      <div className="p-4 flex justify-between items-center hairline-b">
        <div className="font-display text-xl uppercase font-black">DOOR · {user.role.toUpperCase()}</div>
        <div className="font-mono-x text-[10px] uppercase tracking-[0.3em]">{user.email}</div>
      </div>

      <div className="p-4 md:p-8 max-w-2xl mx-auto space-y-6">
        <div className="border-2 border-current p-6">
          <div className="font-mono-x text-xs uppercase tracking-[0.3em]">Camera</div>
          {!scanning ? (
            <button onClick={handleStart} data-testid="start-camera" className="btn-accent w-full mt-4"><Camera className="inline mr-2" size={16} /> START SCANNER</button>
          ) : (
            <>
              <video ref={videoRef} className="w-full mt-4 border border-current" muted playsInline />
              <button onClick={stop} className="btn-primary w-full mt-2">STOP</button>
            </>
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

        {result && <ScanResult result={result} onNext={() => setResult(null)} />}
      </div>
    </div>
  );
}

function ScanResult({ result, onNext }) {
  return (
    <div className="border-4 border-current p-6 text-center" data-testid="scan-result">
      {result.valid ? (
        <>
          <Check size={80} className="mx-auto" />
          <div className="font-display text-6xl uppercase font-black tracking-tighter mt-4">VALID</div>
          {result.event && <div className="font-mono-x uppercase mt-2">{result.event.title}</div>}
          {result.offline && <div className="font-mono-x text-xs mt-2 opacity-70">QUEUED — WILL SYNC WHEN ONLINE</div>}
        </>
      ) : (
        <>
          <X size={80} className="mx-auto" />
          <div className="font-display text-6xl uppercase font-black tracking-tighter mt-4">INVALID</div>
          <div className="font-mono-x uppercase mt-2 text-lg">{result.reason}</div>
        </>
      )}
      <button onClick={onNext} className="border-2 border-current px-6 py-3 mt-6 font-mono-x uppercase tracking-[0.2em] text-sm">NEXT</button>
    </div>
  );
}
