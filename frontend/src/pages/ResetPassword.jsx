import { useState } from "react";
import { useSearchParams, useNavigate, Link } from "react-router-dom";
import { http } from "../api";
import { toast } from "sonner";
import PasswordFields from "../components/PasswordFields";
import { isAcceptable } from "../lib/passwordPolicy";

export default function ResetPassword() {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const token = search.get("token");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
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

  // The client mirrors the server's rules so the form can answer while someone types.
  // It is not the authority: the breach lookup needs a network call this cannot make, so
  // a password can satisfy everything here and still be refused below.
  const ready = isAcceptable(pw) && pw === confirm && confirm.length > 0;

  const submit = async (e) => {
    e.preventDefault();
    if (!ready) return;
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
        <p className="mt-6 text-ink-2 text-sm">Password updated. Redirecting you to sign in…</p>
      ) : (
        <form onSubmit={submit} className="mt-8 space-y-5">
          <PasswordFields
            value={pw} onChange={setPw}
            confirm={confirm} onConfirmChange={setConfirm}
            testId="reset-password"
          />
          <button disabled={busy || !ready} data-testid="reset-submit"
                  className="btn-accent w-full disabled:opacity-40">
            {busy ? "…" : "UPDATE PASSWORD"}
          </button>
        </form>
      )}
    </div>
  );
}
