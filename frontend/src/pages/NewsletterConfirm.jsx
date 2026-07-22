import React, { useEffect, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { http } from "../api";

export default function NewsletterConfirm() {
  const [search] = useSearchParams();
  const [state, setState] = useState("working");

  useEffect(() => {
    const token = search.get("token");
    if (!token) { setState("error"); return; }
    http.get(`/newsletter/confirm?token=${encodeURIComponent(token)}`)
      .then(() => setState("ok"))
      .catch(() => setState("error"));
  }, [search]);

  return (
    <div className="max-w-md mx-auto px-6 py-24 text-center">
      <h1 className="font-display text-4xl uppercase font-black tracking-tighter">
        {state === "working" ? "Confirming…" : state === "ok" ? "You're subscribed" : "Link invalid"}
      </h1>
      <p className="mt-4 text-zinc-400 text-sm">
        {state === "ok"
          ? "Thanks — you'll hear from us about upcoming events."
          : state === "error"
            ? "This confirmation link is invalid or has expired. Subscribe again from the site."
            : "One moment."}
      </p>
      <Link to="/events" className="btn-primary mt-8 inline-block">Browse events</Link>
    </div>
  );
}
