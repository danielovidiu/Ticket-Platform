import React, { useEffect, useRef, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { http } from "../api";

export default function CheckoutSuccess() {
  const [sp] = useSearchParams();
  const sessionId = sp.get("session_id");
  const [status, setStatus] = useState("pending");
  const [attempts, setAttempts] = useState(0);
  const timer = useRef(null);

  useEffect(() => {
    if (!sessionId) return;
    const poll = async (n) => {
      try {
        const { data } = await http.get(`/payments/status/${sessionId}`);
        if (data.payment_status === "paid") { setStatus("paid"); return; }
        if (data.status === "expired") { setStatus("expired"); return; }
        if (n >= 15) { setStatus("timeout"); return; }
        setAttempts(n);
        timer.current = setTimeout(() => poll(n + 1), 2000);
      } catch (e) {
        if (n >= 15) { setStatus("error"); return; }
        timer.current = setTimeout(() => poll(n + 1), 2000);
      }
    };
    poll(0);
    return () => clearTimeout(timer.current);
  }, [sessionId]);

  return (
    <div className="max-w-2xl mx-auto px-6 py-24 text-center">
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">Payment</div>
      {status === "pending" && (
        <>
          <h1 className="font-display text-5xl uppercase font-black mt-3">Processing…</h1>
          <p className="mt-6 text-zinc-400">Hang on. Attempt {attempts + 1}.</p>
        </>
      )}
      {status === "paid" && (
        <>
          <h1 data-testid="pay-success-title" className="font-display text-6xl uppercase font-black mt-3 text-[color:var(--success)]">Paid.</h1>
          <p className="mt-6 text-zinc-300">Your tickets are ready.</p>
          <Link to="/my-tickets" className="btn-accent inline-block mt-8">Open My Tickets</Link>
        </>
      )}
      {status === "expired" && <><h1 className="font-display text-5xl uppercase font-black mt-3 text-[color:var(--accent)]">Session expired</h1><Link to="/events" className="btn-primary mt-8 inline-block">Try again</Link></>}
      {status === "timeout" && <><h1 className="font-display text-5xl uppercase font-black mt-3">Still processing</h1><p className="mt-6 text-zinc-400">Check My Tickets in a minute.</p><Link to="/my-tickets" className="btn-primary mt-8 inline-block">My Tickets</Link></>}
      {status === "error" && <><h1 className="font-display text-5xl uppercase font-black mt-3">Error</h1><Link to="/events" className="btn-primary mt-8 inline-block">Back</Link></>}
    </div>
  );
}
