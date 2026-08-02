import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { http, API } from "../api";
import { useAuth, startLogin } from "../auth";
import { toast } from "sonner";

export default function Settings() {
  const { user, loading, refresh, setUser } = useAuth();
  const navigate = useNavigate();
  const [profile, setProfile] = useState({ first_name: "", last_name: "", phone: "" });
  const [consents, setConsents] = useState({ email_opt_in: false, news_opt_in: false, promo_opt_in: false });
  const [requirePhone, setRequirePhone] = useState(false);

  useEffect(() => {
    http.get("/auth/methods").then((r) => setRequirePhone(!!r.data.require_phone)).catch(() => {});
  }, []);

  useEffect(() => {
    if (user) {
      setProfile({ first_name: user.first_name || "", last_name: user.last_name || "", phone: user.phone || "" });
      setConsents({
        email_opt_in: !!user.email_opt_in,
        news_opt_in: !!user.news_opt_in,
        promo_opt_in: !!user.promo_opt_in,
      });
    }
  }, [user]);

  if (loading) return <div className="p-16 text-center font-mono-x text-ink-4">Loading…</div>;
  if (!user) return (
    <div className="max-w-xl mx-auto px-6 py-24 text-center">
      <h1 className="font-display text-4xl uppercase font-black tracking-tighter">Sign in to manage your account</h1>
      <button onClick={() => startLogin("/settings")} className="btn-accent mt-8">SIGN IN</button>
    </div>
  );

  const saveProfile = async () => {
    try { const { data } = await http.patch("/auth/profile", profile); setUser(data); toast.success("Profile saved"); }
    catch (e) {
      // Name, surname and phone are mandatory, so this endpoint rejects blanks with a
      // message worth showing verbatim.
      const d = e.response?.data?.detail;
      toast.error(typeof d === "string" ? d : "Failed");
    }
  };

  const toggleConsent = async (key) => {
    const next = { ...consents, [key]: !consents[key] };
    setConsents(next);
    try { const { data } = await http.post("/auth/consents", { [key]: next[key] }); setUser(data); }
    catch (e) { toast.error("Failed to update"); setConsents(consents); }
  };

  const resendVerify = async () => {
    try { await http.post("/auth/request-verify"); toast.success("Verification email sent"); }
    catch (e) { toast.error(e.response?.data?.detail || "Failed"); }
  };

  const exportData = () => { window.location.href = `${API}/auth/export`; };

  const deleteAccount = async () => {
    if (!window.confirm("Delete your account? Your personal data is removed. Past invoices are kept (anonymized) for legal retention. This cannot be undone.")) return;
    try {
      await http.delete("/auth/account");
      setUser(null);
      toast.success("Account deleted");
      navigate("/");
    } catch (e) { toast.error(e.response?.data?.detail || "Failed"); }
  };

  const Row = ({ k, label, desc }) => (
    <label className="flex items-start gap-3 py-3 border-b border-ink/10 cursor-pointer">
      <input type="checkbox" checked={consents[k]} onChange={() => toggleConsent(k)} data-testid={`consent-${k}`} className="mt-1" />
      <span>
        <span className="block text-sm">{label}</span>
        <span className="block text-xs text-ink-4">{desc}</span>
      </span>
    </label>
  );

  return (
    <div className="max-w-2xl mx-auto px-6 md:px-10 py-16">
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">Account</div>
      <h1 className="font-display text-5xl md:text-6xl uppercase font-black tracking-tighter mt-2">Settings</h1>

      <section className="mt-12">
        <h2 className="font-mono-x text-xs uppercase tracking-[0.2em] text-ink-3 mb-4">Profile</h2>
        <div className="text-xs text-ink-4 mb-4">
          {user.email}
          {user.email_verified_at
            ? <span className="ml-2 text-ok">✓ verified</span>
            : <button onClick={resendVerify} className="ml-2 underline hover:text-ink">Verify email</button>}
        </div>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <input value={profile.first_name} onChange={(e) => setProfile({ ...profile, first_name: e.target.value })} placeholder="Name" data-testid="settings-first-name" className="input-x w-full" />
            <input value={profile.last_name} onChange={(e) => setProfile({ ...profile, last_name: e.target.value })} placeholder="Surname" data-testid="settings-last-name" className="input-x w-full" />
          </div>
          <input type="tel" value={profile.phone} onChange={(e) => setProfile({ ...profile, phone: e.target.value })}
                 placeholder={requirePhone ? "Phone number" : "Phone number (optional)"}
                 data-testid="settings-phone" className="input-x w-full" />
          <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4">
            {requirePhone ? "All three are required on every account." : "Name and surname are required on every account."}
          </div>
          <button onClick={saveProfile} className="btn-primary w-fit">Save profile</button>
        </div>
      </section>

      <section className="mt-12">
        <h2 className="font-mono-x text-xs uppercase tracking-[0.2em] text-ink-3 mb-2">Communication preferences</h2>
        <Row k="email_opt_in" label="Account &amp; event emails" desc="Order confirmations always send; this covers optional account updates." />
        <Row k="news_opt_in" label="Newsletter" desc="Announcements about upcoming events." />
        <Row k="promo_opt_in" label="Promotions" desc="Occasional offers and discounts." />
      </section>

      <section className="mt-12">
        <h2 className="font-mono-x text-xs uppercase tracking-[0.2em] text-ink-3 mb-4">Your data</h2>
        <div className="flex flex-wrap gap-3">
          <button onClick={exportData} data-testid="export-data" className="btn-primary">Download my data</button>
          <button onClick={deleteAccount} data-testid="delete-account" className="btn-primary !border-brand !text-brand">Delete account</button>
        </div>
      </section>
    </div>
  );
}
