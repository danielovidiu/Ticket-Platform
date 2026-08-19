import { useState } from "react";
import { http } from "../api";
import { toast } from "sonner";

export default function Contact() {
  const [form, setForm] = useState({ name: "", email: "", message: "" });
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await http.post("/contact", form);
      toast.success("Message sent");
      setForm({ name: "", email: "", message: "" });
    } catch { toast.error("Failed"); }
    setBusy(false);
  };
  return (
    <div className="max-w-[1000px] mx-auto px-6 md:px-10 py-16 grid md:grid-cols-2 gap-12">
      <div>
        <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">Reach us</div>
        <h1 className="font-display text-5xl md:text-7xl uppercase font-black tracking-tighter mt-2 leading-none">Contact</h1>
        <div className="mt-10 space-y-4 text-ink-2">
          <div><div className="font-mono-x text-xs uppercase tracking-[0.25em] text-ink-4">Bookings</div>bookings@supersanity.collective</div>
          <div><div className="font-mono-x text-xs uppercase tracking-[0.25em] text-ink-4">Press</div>press@supersanity.collective</div>
          <div><div className="font-mono-x text-xs uppercase tracking-[0.25em] text-ink-4">Studio</div>Bucharest, RO</div>
        </div>
      </div>
      <form onSubmit={submit} className="border border-ink/10 bg-surface p-6 md:p-8 space-y-4">
        <input required data-testid="contact-name" placeholder="NAME" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input-x" />
        <input required data-testid="contact-email" type="email" placeholder="EMAIL" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="input-x" />
        <textarea required data-testid="contact-message" placeholder="MESSAGE" rows={6} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} className="input-x" />
        <button disabled={busy} data-testid="contact-submit" className="btn-accent w-full">{busy ? "SENDING…" : "SEND"}</button>
      </form>
    </div>
  );
}
