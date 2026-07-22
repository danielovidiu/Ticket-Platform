import React, { useEffect, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { http } from "../api";

export default function VerifyEmail() {
  const [search] = useSearchParams();
  const [state, setState] = useState("working"); // working | ok | error

  useEffect(() => {
    const token = search.get("token");
    if (!token) { setState("error"); return; }
    http.get(`/auth/verify?token=${encodeURIComponent(token)}`)
      .then(() => setState("ok"))
      .catch(() => setState("error"));
  }, [search]);

  return (
    <div className="max-w-md mx-auto px-6 py-24 text-center">
      <h1 className="font-display text-4xl uppercase font-black tracking-tighter">
        {state === "working" ? "Verifying…" : state === "ok" ? "Email verified" : "Link invalid"}
      </h1>
      <p className="mt-4 text-zinc-400 text-sm">
        {state === "ok"
          ? "Your email address is confirmed."
          : state === "error"
            ? "This verification link is invalid or has expired. Request a new one from your settings."
            : "One moment."}
      </p>
      {state !== "working" && (
        <Link to="/settings" className="btn-primary mt-8 inline-block">Go to settings</Link>
      )}
    </div>
  );
}
