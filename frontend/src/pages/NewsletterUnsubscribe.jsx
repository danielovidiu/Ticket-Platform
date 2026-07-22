import React, { useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { http } from "../api";
import { toast } from "sonner";

/** The actual unsubscribe MUST be a POST triggered by a button click — never a
 * side effect of loading the page, or email-client link prefetchers would
 * unsubscribe people who merely received the email. */
export default function NewsletterUnsubscribe() {
  const [search] = useSearchParams();
  const token = search.get("token");
  const [state, setState] = useState(token ? "ready" : "error"); // ready | working | done | error

  const unsub = async () => {
    setState("working");
    try {
      await http.post("/newsletter/unsubscribe", { token });
      setState("done");
    } catch (err) {
      toast.error(err.response?.data?.detail || "This link is invalid or has expired");
      setState("error");
    }
  };

  return (
    <div className="max-w-md mx-auto px-6 py-24 text-center">
      <h1 className="font-display text-4xl uppercase font-black tracking-tighter">
        {state === "done" ? "Unsubscribed" : "Unsubscribe"}
      </h1>
      {state === "done" ? (
        <p className="mt-4 text-zinc-400 text-sm">You won't receive newsletter emails from us anymore.</p>
      ) : state === "error" ? (
        <p className="mt-4 text-zinc-400 text-sm">This unsubscribe link is invalid or has expired.</p>
      ) : (
        <>
          <p className="mt-4 text-zinc-400 text-sm">Stop receiving Supersanity event announcements?</p>
          <button onClick={unsub} disabled={state === "working"} data-testid="unsub-confirm" className="btn-accent mt-8">
            {state === "working" ? "…" : "UNSUBSCRIBE"}
          </button>
        </>
      )}
      <div className="mt-8"><Link to="/" className="font-mono-x text-[11px] uppercase tracking-[0.2em] text-zinc-500 hover:text-white">← Home</Link></div>
    </div>
  );
}
