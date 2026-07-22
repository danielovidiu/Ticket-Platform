import React, { useState } from "react";
import { useSearchParams, useNavigate, Link } from "react-router-dom";
import { http } from "../api";
import { toast } from "sonner";

export default function ResetPassword() {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const token = search.get("token");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (!token) {
    return (
      <div className="max-w-md mx-auto px-6 py-24 text-center">
        <h1 className="font-display text-4xl uppercase font-black tracking-tighter">Link invalid</h1>
        <Link to="/login" className="btn-primary mt-8 inline-block">Back to sign in</Link>
      </div>
    );
  }

  const submit = async (e) => {
    e.preventDefault();
    if (pw.length < 8) { toast.error("Password must be at least 8 characters"); return; }
    setBusy(true);
    try {
      await http.post("/auth/reset-password", { token, new_password: pw });
      setDone(true);
      setTimeout(() => navigate("/login", { replace: true }), 1800);
    } catch (err) {
      toast.error(err.response?.data?.detail || "This reset link is invalid or has expired");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-md mx-auto px-6 py-24">
      <h1 className="font-display text-4xl uppercase font-black tracking-tighter">Set a new password</h1>
      {done ? (
        <p className="mt-6 text-zinc-300 text-sm">Password updated. Redirecting you to sign in…</p>
      ) : (
        <form onSubmit={submit} className="mt-8 space-y-4">
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="New password" data-testid="reset-password" className="input-x w-full" />
          <button disabled={busy} data-testid="reset-submit" className="btn-accent w-full">{busy ? "…" : "UPDATE PASSWORD"}</button>
        </form>
      )}
    </div>
  );
}
