import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { http, API } from "../api";
import { useAuth } from "../auth";
import { toast } from "sonner";

const safeReturn = (p) => (p && p.startsWith("/") && !p.startsWith("//") ? p : "/my-tickets");

export default function Login() {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { user, setUser } = useAuth();
  const returnTo = safeReturn(search.get("return"));

  const [mode, setMode] = useState("login"); // login | register | forgot
  const [methods, setMethods] = useState({ password: true, google: false, apple: false });
  const [form, setForm] = useState({ email: "", password: "", name: "", tos: false, news_opt_in: false, promo_opt_in: false });
  const [busy, setBusy] = useState(false);
  const [sentReset, setSentReset] = useState(false);

  useEffect(() => { http.get("/auth/methods").then((r) => setMethods(r.data)).catch(() => {}); }, []);

  // Already signed in → bounce to the return target.
  useEffect(() => { if (user) navigate(returnTo, { replace: true }); }, [user, returnTo, navigate]);

  // Surface the account-linking gate message coming back from an OAuth callback.
  useEffect(() => {
    if (search.get("error") === "use_existing_method") {
      toast.error("An account with this email already exists. Sign in with your original method.");
    }
  }, [search]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "forgot") {
        await http.post("/auth/forgot-password", { email: form.email });
        setSentReset(true);
        return;
      }
      const path = mode === "register" ? "/auth/register" : "/auth/login";
      const body = mode === "register"
        ? { email: form.email, password: form.password, name: form.name, tos_accepted: form.tos, news_opt_in: form.news_opt_in, promo_opt_in: form.promo_opt_in }
        : { email: form.email, password: form.password };
      const { data } = await http.post(path, body);
      setUser(data.user);
      navigate(returnTo, { replace: true });
    } catch (err) {
      toast.error(err.response?.data?.detail || "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const providerHref = (p) => `${API}/auth/${p}/start?return=${encodeURIComponent(returnTo)}`;

  return (
    <div className="max-w-md mx-auto px-6 py-20">
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">Box Office</div>
      <h1 className="font-display text-4xl md:text-5xl uppercase font-black tracking-tighter mt-2">
        {mode === "register" ? "Create account" : mode === "forgot" ? "Reset password" : "Sign in"}
      </h1>

      {(methods.google || methods.apple) && mode !== "forgot" && (
        <div className="mt-8 space-y-3">
          {methods.google && <a href={providerHref("google")} data-testid="login-google" className="btn-primary w-full text-center block">Continue with Google</a>}
          {methods.apple && <a href={providerHref("apple")} data-testid="login-apple" className="btn-primary w-full text-center block">Continue with Apple</a>}
          <div className="flex items-center gap-3 text-zinc-600 font-mono-x text-[10px] uppercase tracking-[0.3em] py-2">
            <span className="h-px flex-1 bg-white/10" /> or <span className="h-px flex-1 bg-white/10" />
          </div>
        </div>
      )}

      {sentReset ? (
        <p className="mt-8 text-zinc-300 text-sm leading-relaxed">
          If an account exists for that email, we've sent a reset link. Check your inbox.
        </p>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-4">
          {mode === "register" && (
            <input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Name" data-testid="login-name" className="input-x w-full" />
          )}
          <input type="email" required value={form.email} onChange={(e) => set("email", e.target.value)} placeholder="Email" data-testid="login-email" className="input-x w-full" />
          {mode !== "forgot" && (
            <input type="password" required value={form.password} onChange={(e) => set("password", e.target.value)} placeholder="Password" data-testid="login-password" className="input-x w-full" />
          )}

          {mode === "register" && (
            <div className="space-y-2 pt-1">
              <label className="flex items-start gap-2 text-xs text-zinc-300">
                <input type="checkbox" checked={form.tos} onChange={(e) => set("tos", e.target.checked)} data-testid="login-tos" className="mt-0.5" />
                <span>I accept the <Link to="/terms" className="underline">Terms of Service</Link> and <Link to="/privacy" className="underline">Privacy Policy</Link>.</span>
              </label>
              <label className="flex items-start gap-2 text-xs text-zinc-400">
                <input type="checkbox" checked={form.news_opt_in} onChange={(e) => set("news_opt_in", e.target.checked)} className="mt-0.5" />
                <span>Email me about upcoming events (optional).</span>
              </label>
              <label className="flex items-start gap-2 text-xs text-zinc-400">
                <input type="checkbox" checked={form.promo_opt_in} onChange={(e) => set("promo_opt_in", e.target.checked)} className="mt-0.5" />
                <span>Send me occasional promotions (optional).</span>
              </label>
            </div>
          )}

          <button disabled={busy} data-testid="login-submit" className="btn-accent w-full">
            {busy ? "…" : mode === "register" ? "CREATE ACCOUNT" : mode === "forgot" ? "SEND RESET LINK" : "SIGN IN"}
          </button>
        </form>
      )}

      <div className="mt-6 flex justify-between font-mono-x text-[11px] uppercase tracking-[0.2em] text-zinc-500">
        {mode === "login" && (
          <>
            <button onClick={() => { setMode("register"); setSentReset(false); }} data-testid="switch-register" className="hover:text-white">Create account</button>
            <button onClick={() => { setMode("forgot"); setSentReset(false); }} className="hover:text-white">Forgot password</button>
          </>
        )}
        {mode !== "login" && (
          <button onClick={() => { setMode("login"); setSentReset(false); }} data-testid="switch-login" className="hover:text-white">← Back to sign in</button>
        )}
      </div>
    </div>
  );
}
