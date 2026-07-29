import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { http } from "../api";
import { useAuth, startLogin } from "../auth";
import { toast } from "sonner";

const safeReturn = (p) => (p && p.startsWith("/") && !p.startsWith("//") ? p : "/my-tickets");

/**
 * Collects the three fields every account must carry — name, surname, phone — for
 * anyone who doesn't have them yet: accounts created before the rule existed, and
 * Google/Apple sign-ups (a provider hands over the name but never a phone number).
 *
 * ProfileGate in App.js redirects here and blocks the rest of the app until this
 * saves, so there is no "skip" — the same rule is enforced server-side at checkout.
 */
export default function CompleteProfile() {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { user, loading, setUser } = useAuth();
  const returnTo = safeReturn(search.get("return"));

  const [form, setForm] = useState({ first_name: "", last_name: "", phone: "" });
  const [busy, setBusy] = useState(false);
  // Whether a phone number is mandatory is the deployment's call (REQUIRE_PHONE).
  const [requirePhone, setRequirePhone] = useState(false);

  useEffect(() => {
    http.get("/auth/methods").then((r) => setRequirePhone(!!r.data.require_phone)).catch(() => {});
  }, []);

  // Prefill whatever we already know — typically the name Google sent, leaving only
  // the phone number to type.
  useEffect(() => {
    if (user) setForm({ first_name: user.first_name || "", last_name: user.last_name || "", phone: user.phone || "" });
  }, [user]);

  // Nothing left to complete → don't sit on a form the user has already filled in.
  useEffect(() => {
    if (user?.profile_complete) navigate(returnTo, { replace: true });
  }, [user, returnTo, navigate]);

  if (loading) return <div className="p-16 text-center font-mono-x text-zinc-500">Loading…</div>;
  if (!user) return (
    <div className="max-w-xl mx-auto px-6 py-24 text-center">
      <h1 className="font-display text-4xl uppercase font-black tracking-tighter">Sign in to continue</h1>
      <button onClick={() => startLogin(returnTo)} className="btn-accent mt-8">SIGN IN</button>
    </div>
  );

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { data } = await http.patch("/auth/profile", form);
      setUser(data);
      toast.success("Profile complete");
      navigate(returnTo, { replace: true });
    } catch (err) {
      const d = err.response?.data?.detail;
      toast.error(typeof d === "string" ? d : "Could not save your details");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-md mx-auto px-6 py-20" data-testid="complete-profile">
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">Account</div>
      <h1 className="font-display text-4xl md:text-5xl uppercase font-black tracking-tighter mt-2">One last thing</h1>
      <p className="mt-6 text-zinc-300 text-sm leading-relaxed">
        {requirePhone
          ? "We need your full name and a phone number before you can buy tickets — the name goes on the ticket, and the number is how the door reaches you if an event changes."
          : "We need your full name before you can buy tickets — it goes on the ticket. A phone number is optional, and lets the door reach you if an event changes."}
      </p>

      <form onSubmit={submit} className="mt-8 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <input required value={form.first_name} onChange={(e) => set("first_name", e.target.value)} placeholder="Name" data-testid="profile-first-name" className="input-x w-full" />
          <input required value={form.last_name} onChange={(e) => set("last_name", e.target.value)} placeholder="Surname" data-testid="profile-last-name" className="input-x w-full" />
        </div>
        <input required={requirePhone} type="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)}
               placeholder={requirePhone ? "Phone number" : "Phone number (optional)"}
               data-testid="profile-phone" className="input-x w-full" />
        <button disabled={busy} data-testid="profile-submit" className="btn-accent w-full">{busy ? "…" : "SAVE AND CONTINUE"}</button>
      </form>

      <div className="mt-6 font-mono-x text-[10px] uppercase tracking-[0.2em] text-zinc-500">
        Signed in as {user.email}
      </div>
    </div>
  );
}
