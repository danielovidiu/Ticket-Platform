import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { ensureFontPreview } from "../lib/cms";

/**
 * Families offered by default. Curated rather than the whole Google catalogue: a list of
 * eighteen hundred names is a worse tool than a list of twenty good ones, and the
 * free-text row at the bottom of the panel still reaches anything Google serves.
 */
export const GOOGLE_SUGGESTIONS = [
  "Clash Display", "Space Grotesk", "Inter", "Manrope", "Playfair Display",
  "IBM Plex Mono", "JetBrains Mono", "Archivo", "Bebas Neue", "Anton",
  "Syne", "Fraunces", "Rubik", "DM Sans", "Instrument Serif",
  "Big Shoulders Display", "Unbounded", "Cormorant Garamond", "Public Sans", "Geist",
];

const slug = (s) => s.toLowerCase().replace(/\s+/g, "-");

const Group = ({ title, children }) => (
  <div>
    <div className="px-3 pt-3 pb-1 font-mono-x text-[9px] uppercase tracking-[0.3em] text-ink-5">
      {title}
    </div>
    {children}
  </div>
);

/* Each option is set in its own face. Choosing type from a list of names rendered in one
   typeface is choosing blind — the preview is the entire point of a picker over the text
   input this replaces. */
const Option = ({ family, active, onPick, testId }) => (
  <button type="button" role="option" aria-selected={active} onClick={() => onPick(family)}
          data-testid={`${testId}-option-${slug(family)}`}
          className={`block w-full text-left px-3 py-2 truncate text-base hover:bg-ink/10 ${
            active ? "bg-ink/10 text-ink" : "text-ink-2"}`}
          style={{ fontFamily: `"${family}"` }}>
    {family}
  </button>
);

/**
 * One font slot — display, body or mono. Lists the artist's uploaded faces first, then
 * the curated Google set, and accepts any other Google family typed in by name.
 */
export default function FontPicker({ label, value, custom = [], onChange, testId = "font-picker" }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [freeText, setFreeText] = useState("");
  const ref = useRef(null);

  const customFamilies = useMemo(
    () => [...new Set(custom.map((f) => (f.family || "").trim()).filter(Boolean))].sort(),
    [custom],
  );

  // The closed button also renders in its own face, so the current choice needs loading
  // whether or not the panel is ever opened.
  useEffect(() => { if (value) ensureFontPreview(value); }, [value]);

  // The rest only on open: a CMS session that never touches typography should not pull
  // twenty stylesheets.
  useEffect(() => {
    if (!open) return;
    [...customFamilies, ...GOOGLE_SUGGESTIONS].forEach(ensureFontPreview);
  }, [open, customFamilies]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const needle = q.trim().toLowerCase();
  const match = (f) => f.toLowerCase().includes(needle);
  const mine = customFamilies.filter(match);
  const google = GOOGLE_SUGGESTIONS.filter(match);

  const pick = (family) => { onChange(family); setOpen(false); setQ(""); };

  return (
    <div className="relative" ref={ref} data-testid={testId}>
      <div className="text-[10px] uppercase tracking-[0.2em] text-ink-3 font-mono-x mb-1">{label}</div>
      <button type="button" onClick={() => setOpen((v) => !v)}
              aria-haspopup="listbox" aria-expanded={open}
              data-testid={`${testId}-toggle`}
              className="input-x !py-2 flex items-center justify-between gap-2 text-left">
        <span className="truncate" style={{ fontFamily: value ? `"${value}"` : undefined }}>
          {value || <span className="text-ink-4 text-sm">Choose a font…</span>}
        </span>
        <ChevronDown size={13} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div role="listbox" data-testid={`${testId}-panel`}
             className="absolute z-50 left-0 right-0 mt-1 max-h-[22rem] overflow-y-auto border border-ink/20 bg-page">
          <div className="sticky top-0 z-10 bg-page p-2 border-b border-ink/10">
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)}
                   placeholder="Search fonts…" data-testid={`${testId}-search`}
                   className="input-x !py-1.5 !text-xs" />
          </div>

          {mine.length > 0 && (
            <Group title="Your uploads">
              {mine.map((f) => <Option key={f} family={f} active={f === value} onPick={pick} testId={testId} />)}
            </Group>
          )}
          {google.length > 0 && (
            <Group title="Google Fonts">
              {google.map((f) => <Option key={f} family={f} active={f === value} onPick={pick} testId={testId} />)}
            </Group>
          )}
          {mine.length === 0 && google.length === 0 && (
            <div className="px-3 py-4 font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4">
              Nothing matches — name it exactly below
            </div>
          )}

          {/* The curated list is a shortcut, not a boundary. */}
          <div className="border-t border-ink/10 p-2">
            <div className="text-[10px] uppercase tracking-[0.2em] text-ink-4 font-mono-x mb-1">
              Any Google family
            </div>
            <form className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const v = freeText.trim();
                    if (v) { pick(v); setFreeText(""); }
                  }}>
              <input value={freeText} onChange={(e) => setFreeText(e.target.value)}
                     placeholder="e.g. Libre Baskerville" data-testid={`${testId}-freetext`}
                     className="input-x !py-1.5 !text-xs flex-1" />
              <button type="submit" className="btn-primary !py-1.5 !px-3 !text-[10px]">Use</button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
