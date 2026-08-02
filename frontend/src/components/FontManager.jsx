import React, { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { http } from "../api";

/* Longest-first, and the compounds before the word they contain: "SemiBold" and
   "ExtraBold" both match /bold/, so a plain /bold/ test placed first would call every
   weight 700. */
const WEIGHT_WORDS = [
  [/thin|hairline/i, 100],
  [/extra[-_ ]?light|ultra[-_ ]?light/i, 200],
  [/semi[-_ ]?bold|demi[-_ ]?bold/i, 600],
  [/extra[-_ ]?bold|ultra[-_ ]?bold/i, 800],
  [/black|heavy/i, 900],
  [/light/i, 300],
  [/medium/i, 500],
  [/bold/i, 700],
  [/regular|normal|book/i, 400],
];

const WEIGHTS = [
  [100, "100 Thin"], [200, "200 Extra Light"], [300, "300 Light"], [400, "400 Regular"],
  [500, "500 Medium"], [600, "600 Semi Bold"], [700, "700 Bold"], [800, "800 Extra Bold"],
  [900, "900 Black"],
];

/**
 * First guess at what a font file is, from its name. Foundries name files predictably
 * enough that this is usually right ("AcmeGrotesk-SemiBoldItalic.woff2"), and every part
 * of it stays editable because sometimes they don't.
 *
 * Reading the family out of the font's own name table would be exact, but that needs a
 * font parser on the server; this needs nothing and is wrong in a way the user can see
 * and fix before uploading.
 */
export function guessFromFilename(name) {
  const base = String(name || "").replace(/\.[^.]+$/, "");
  const style = /italic|oblique/i.test(base) ? "italic" : "normal";
  let weight = 400;
  for (const [re, w] of WEIGHT_WORDS) {
    if (re.test(base)) { weight = w; break; }
  }
  const family = base
    .split(/[-_]/)[0]
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")  // AcmeGrotesk -> Acme Grotesk
    .replace(/\s+/g, " ")
    .trim();
  return { family, weight, style };
}

const kb = (n) => `${Math.max(1, Math.round((n || 0) / 1024))} KB`;

/**
 * Upload and manage the site's own font files.
 *
 * One row per face — a family with a regular and a bold is two uploads sharing a family
 * name, which is what lets the browser pick the right file per weight instead of
 * synthesising a fake bold from the regular.
 */
export default function FontManager({ fonts = [], onChanged }) {
  const fileRef = useRef(null);
  const [pending, setPending] = useState(null); // { file, family, weight, style }
  const [busy, setBusy] = useState(false);

  const families = useMemo(() => {
    const m = new Map();
    for (const f of fonts) {
      if (!m.has(f.family)) m.set(f.family, []);
      m.get(f.family).push(f);
    }
    return [...m.entries()];
  }, [fonts]);

  const onFile = (file) => {
    if (!file) return;
    setPending({ file, ...guessFromFilename(file.name) });
  };

  const submit = async (e) => {
    e.preventDefault();
    const family = (pending?.family || "").trim();
    if (!pending?.file || !family) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", pending.file);
      fd.append("family", family);
      fd.append("weight", String(pending.weight));
      fd.append("style", pending.style);
      await http.post("/admin/cms/fonts", fd);
      toast.success(`${family} ${pending.weight} added`);
      setPending(null);
      await onChanged();
    } catch (err) {
      const d = err.response?.data?.detail;
      toast.error(typeof d === "string" ? d : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (f) => {
    if (f.in_use && !window.confirm(
      `"${f.family}" is selected in your theme. Delete this file anyway? Text set in it will fall back to another font.`
    )) return;
    try {
      await http.delete(`/admin/cms/fonts/${f.font_id}`);
      await onChanged();
    } catch {
      toast.error("Could not delete that font");
    }
  };

  return (
    <div data-testid="font-manager">
      {families.length === 0 && !pending && (
        <div className="border border-dashed border-ink/15 px-3 py-4 font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 leading-relaxed">
          No uploads yet — the picker above still offers Google Fonts
        </div>
      )}

      {families.map(([family, faces]) => (
        <div key={family} className="border border-ink/10 mb-2" data-testid={`font-family-${family.toLowerCase().replace(/\s+/g, "-")}`}>
          <div className="px-3 py-2 border-b border-ink/10 truncate text-base" style={{ fontFamily: `"${family}"` }}>
            {family}
          </div>
          {faces.map((f) => (
            <div key={f.font_id} className="flex items-center gap-2 px-3 py-1.5 font-mono-x text-[10px] uppercase tracking-[0.15em] text-ink-3">
              <span className="flex-1 truncate">
                {f.weight}{f.style === "italic" ? " Italic" : ""} · {f.format} · {kb(f.size)}
              </span>
              {f.in_use && <span className="text-brand shrink-0">In use</span>}
              <button type="button" onClick={() => remove(f)} aria-label={`Delete ${f.family} ${f.weight}`}
                      data-testid={`delete-font-${f.font_id}`}
                      className="shrink-0 text-ink-4 hover:text-brand">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      ))}

      {!pending && (
        <>
          <button type="button" onClick={() => fileRef.current?.click()}
                  data-testid="font-upload-btn" className="btn-primary w-full !py-2 !text-[10px] mt-1">
            Upload a font file
          </button>
          {/* Licensing is the artist's to hold, and it is not obvious that a desktop
              licence rarely covers serving the file to browsers. Say it where the choice
              is made rather than in a terms page nobody opens. */}
          <div className="mt-2 font-mono-x text-[9px] uppercase tracking-[0.15em] text-ink-5 leading-relaxed">
            WOFF2, WOFF, TTF or OTF · max 5MB · you need a webfont licence for files you upload
          </div>
        </>
      )}

      <input ref={fileRef} type="file" className="hidden" data-testid="font-file-input"
             accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"
             onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; onFile(f); }} />

      {pending && (
        <form onSubmit={submit} className="border border-ink/20 p-3 space-y-2 mt-1" data-testid="font-upload-form">
          <div className="font-mono-x text-[9px] uppercase tracking-[0.2em] text-ink-4 truncate">
            {pending.file.name}
          </div>
          <label className="block">
            <div className="text-[10px] uppercase tracking-[0.2em] text-ink-3 font-mono-x mb-1">Family name</div>
            <input value={pending.family} data-testid="font-family-input"
                   onChange={(e) => setPending({ ...pending, family: e.target.value })}
                   placeholder="Acme Grotesk" className="input-x !py-1.5 !text-xs" />
          </label>
          <div className="flex gap-2">
            <label className="flex-1">
              <div className="text-[10px] uppercase tracking-[0.2em] text-ink-3 font-mono-x mb-1">Weight</div>
              <select value={pending.weight} data-testid="font-weight-select"
                      onChange={(e) => setPending({ ...pending, weight: Number(e.target.value) })}
                      className="input-x !py-1.5 !text-xs">
                {WEIGHTS.map(([w, label]) => <option key={w} value={w}>{label}</option>)}
              </select>
            </label>
            <label className="flex-1">
              <div className="text-[10px] uppercase tracking-[0.2em] text-ink-3 font-mono-x mb-1">Style</div>
              <select value={pending.style} data-testid="font-style-select"
                      onChange={(e) => setPending({ ...pending, style: e.target.value })}
                      className="input-x !py-1.5 !text-xs">
                <option value="normal">Normal</option>
                <option value="italic">Italic</option>
              </select>
            </label>
          </div>
          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={busy || !pending.family.trim()}
                    data-testid="font-upload-submit"
                    className="btn-accent flex-1 !py-2 !text-[10px] disabled:opacity-40">
              {busy ? "Uploading…" : "Add font"}
            </button>
            <button type="button" onClick={() => setPending(null)} className="btn-primary !py-2 !px-3 !text-[10px]">
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
