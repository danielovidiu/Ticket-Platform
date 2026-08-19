import { useEffect, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { http, API } from "../api";
import { useAuth } from "../auth";
import { notifyError } from "../lib/notify";

const safeReturn = (p) => (p && p.startsWith("/") && !p.startsWith("//") ? p : "/my-tickets");

/** The API returns `detail` as a plain string for most errors and as an object
 * ({reason, email}) for the ones the UI has to branch on — see the 403 in login(). */
const detailOf = (err) => err?.response?.data?.detail;
const messageOf = (err, fallback) => {
  const d = detailOf(err);
  return typeof d === "string" ? d : fallback;
};

export default function Login() {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { user, setUser } = useAuth();
  const returnTo = safeReturn(search.get("return"));

  const [mode, setMode] = useState("login"); // login | register | forgot
  // require_phone is a deployment setting (REQUIRE_PHONE on the backend), so the form
  // asks for it as optional until this says otherwise.
  const [methods, setMethods] = useState({ password: true, google: false, apple: false, require_phone: false });
  const [form, setForm] = useState({
    email: "", password: "", first_name: "", last_name: "", phone: "",
    tos: false, news_opt_in: false, promo_opt_in: false,
  });
  const [busy, setBusy] = useState(false);
  const [sentReset, setSentReset] = useState(false);
  // Set once an account exists but its address is unconfirmed — after registering, or
  // after a login the server refused for that reason. Holds the address so the resend
  // button doesn't have to ask for it again.
  const [pendingEmail, setPendingEmail] = useState(null);
  const [resent, setResent] = useState(false);

  useEffect(() => { http.get("/auth/methods").then((r) => setMethods(r.data)).catch(() => {}); }, []);

  // Already signed in → bounce to the return target.
  useEffect(() => { if (user) navigate(returnTo, { replace: true }); }, [user, returnTo, navigate]);

  // Surface what an OAuth callback bounced back with: the account-linking gate, or the
  // same unverified-address gate that password login applies.
  useEffect(() => {
    const error = search.get("error");
    if (error === "use_existing_method") {
      notifyError("An account with this email already exists. Sign in with your original method.");
    } else if (error === "email_not_verified") {
      setPendingEmail(search.get("email") || "");
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
      if (mode === "register") {
        await http.post("/auth/register", {
          email: form.email, password: form.password,
          first_name: form.first_name, last_name: form.last_name, phone: form.phone,
          tos_accepted: form.tos, news_opt_in: form.news_opt_in, promo_opt_in: form.promo_opt_in,
        });
        // No session is issued until the emailed link is clicked.
        setPendingEmail(form.email);
        return;
      }
      const { data } = await http.post("/auth/login", { email: form.email, password: form.password });
      setUser(data.user);
      navigate(returnTo, { replace: true });
    } catch (err) {
      const d = detailOf(err);
      if (d?.reason === "email_not_verified") {
        setPendingEmail(d.email || form.email);
        return;
      }
      notifyError(messageOf(err, "Something went wrong"));
    } finally {
      setBusy(false);
    }
  };

  const resendVerification = async () => {
    setBusy(true);
    try {
      await http.post("/auth/resend-verification", { email: pendingEmail });
      setResent(true);
    } catch (err) {
      notifyError(messageOf(err, "Could not send the email. Try again in a few minutes."));
    } finally {
      setBusy(false);
    }
  };

  const providerHref = (p) => `${API}/auth/${p}/start?return=${encodeURIComponent(returnTo)}`;

  const backToLogin = () => {
    setMode("login");
    setSentReset(false);
    setPendingEmail(null);
    setResent(false);
  };

  if (pendingEmail !== null) {
    return (
      <div className="max-w-md mx-auto px-6 py-20" data-testid="verify-pending">
        <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">Box Office</div>
        <h1 className="font-display text-4xl md:text-5xl uppercase font-black tracking-tighter mt-2">Confirm your email</h1>
        <p className="mt-6 text-ink-2 text-sm leading-relaxed">
          We've sent a confirmation link{pendingEmail ? <> to <span className="text-ink">{pendingEmail}</span></> : null}.
          Open it to activate your account — you can't sign in until you do.
        </p>
        <p className="mt-3 text-ink-4 text-xs leading-relaxed">
          Nothing in your inbox after a minute or two? Check spam, then send it again.
        </p>
        <button
          onClick={resendVerification}
          disabled={busy || resent || !pendingEmail}
          data-testid="resend-verification"
          className="btn-primary mt-8 w-full disabled:opacity-40"
        >
          {resent ? "LINK SENT" : busy ? "…" : "SEND IT AGAIN"}
        </button>
        <button onClick={backToLogin} data-testid="back-to-login" className="mt-6 font-mono-x text-[11px] uppercase tracking-[0.2em] text-ink-4 hover:text-ink">
          ← Back to sign in
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto px-6 py-20">
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">Box Office</div>
      <h1 className="font-display text-4xl md:text-5xl uppercase font-black tracking-tighter mt-2">
        {mode === "register" ? "Create account" : mode === "forgot" ? "Reset password" : "Sign in"}
      </h1>

      {(methods.google || methods.apple) && mode !== "forgot" && (
        <div className="mt-8 space-y-3">
          {methods.google && <a href={providerHref("google")} data-testid="login-google" className="btn-primary w-full text-center block">Continue with Google</a>}
          {methods.apple && <a href={providerHref("apple")} data-testid="login-apple" className="btn-primary w-full text-center block">Continue with Apple</a>}
          {mode === "register" && methods.require_phone && (
            <p className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 leading-relaxed">
              Your name comes across automatically — we'll ask for a phone number once.
            </p>
          )}
          <div className="flex items-center gap-3 text-ink-5 font-mono-x text-[10px] uppercase tracking-[0.3em] py-2">
            <span className="h-px flex-1 bg-ink/10" /> or <span className="h-px flex-1 bg-ink/10" />
          </div>
        </div>
      )}

      {sentReset ? (
        <p className="mt-8 text-ink-2 text-sm leading-relaxed">
          If an account exists for that email, we've sent a reset link. Check your inbox.
        </p>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-4">
          {mode === "register" && (
            <div className="grid grid-cols-2 gap-3">
              <input required value={form.first_name} onChange={(e) => set("first_name", e.target.value)} placeholder="Name" data-testid="login-first-name" className="input-x w-full" />
              <input required value={form.last_name} onChange={(e) => set("last_name", e.target.value)} placeholder="Surname" data-testid="login-last-name" className="input-x w-full" />
            </div>
          )}
          <input type="email" required value={form.email} onChange={(e) => set("email", e.target.value)} placeholder="Email" data-testid="login-email" className="input-x w-full" />
          {mode === "register" && (
            <input type="tel" required={methods.require_phone} value={form.phone} onChange={(e) => set("phone", e.target.value)}
                   placeholder={methods.require_phone ? "Phone number" : "Phone number (optional)"}
                   data-testid="login-phone" className="input-x w-full" />
          )}
          {mode !== "forgot" && (
            <input type="password" required value={form.password} onChange={(e) => set("password", e.target.value)} placeholder="Password" data-testid="login-password" className="input-x w-full" />
          )}

          {mode === "register" && (
            <div className="space-y-2 pt-1">
              <label className="flex items-start gap-2 text-xs text-ink-2">
                <input type="checkbox" checked={form.tos} onChange={(e) => set("tos", e.target.checked)} data-testid="login-tos" className="mt-0.5" />
                <span>I accept the <Link to="/terms" className="underline">Terms of Service</Link> and <Link to="/privacy" className="underline">Privacy Policy</Link>.</span>
              </label>
              <label className="flex items-start gap-2 text-xs text-ink-3">
                <input type="checkbox" checked={form.news_opt_in} onChange={(e) => set("news_opt_in", e.target.checked)} className="mt-0.5" />
                <span>Email me about upcoming events (optional).</span>
              </label>
              <label className="flex items-start gap-2 text-xs text-ink-3">
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

      <div className="mt-6 flex justify-between font-mono-x text-[11px] uppercase tracking-[0.2em] text-ink-4">
        {mode === "login" && (
          <>
            <button onClick={() => { setMode("register"); setSentReset(false); }} data-testid="switch-register" className="hover:text-ink">Create account</button>
            <button onClick={() => { setMode("forgot"); setSentReset(false); }} className="hover:text-ink">Forgot password</button>
          </>
        )}
        {mode !== "login" && (
          <button onClick={backToLogin} data-testid="switch-login" className="hover:text-ink">← Back to sign in</button>
        )}
      </div>
    </div>
  );
}
