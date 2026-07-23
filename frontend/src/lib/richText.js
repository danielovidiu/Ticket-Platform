import React from "react";

/**
 * Shared markdown-ish subset used everywhere free text is entered: event
 * descriptions, artist bios, project descriptions, and CMS body/content
 * fields. Deliberately not full CommonMark — just enough to back the
 * formatting toolbar (see FormatToolbar / wrapTextareaSelection below).
 *
 * Block level: #/##/### headings, blank-line paragraphs, ALL-CAPS eyebrow lines.
 * Inline: **bold**, *italic*, ~~strikethrough~~, __underline__, [text](url).
 * (Markdown has no native underline mark — `__x__` is repurposed for it here
 * since this subset doesn't use `__` for anything else.)
 */
export function renderRich(md, opts = {}) {
  if (!md) return null;
  const paraClassName = opts.paraClassName || "text-zinc-300 text-lg leading-relaxed max-w-2xl mt-4";
  const lines = String(md).split(/\n/);
  const nodes = [];
  let paraBuf = [];
  const flushPara = () => {
    if (paraBuf.length === 0) return;
    const text = paraBuf.join(" ");
    nodes.push(<p key={`p${nodes.length}`} className={paraClassName}>{renderInline(text)}</p>);
    paraBuf = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") { flushPara(); continue; }
    if (line.startsWith("### ")) { flushPara(); nodes.push(<h3 key={`h${nodes.length}`} className="font-display text-2xl md:text-3xl uppercase font-bold tracking-tight mt-8">{renderInline(line.slice(4))}</h3>); continue; }
    if (line.startsWith("## ")) { flushPara(); nodes.push(<h2 key={`h${nodes.length}`} className="font-display text-3xl md:text-5xl uppercase font-bold tracking-tighter mt-10">{renderInline(line.slice(3))}</h2>); continue; }
    if (line.startsWith("# ")) { flushPara(); nodes.push(<h1 key={`h${nodes.length}`} className="font-display text-5xl md:text-7xl uppercase font-black tracking-tighter mt-4 leading-[0.9]">{renderInline(line.slice(2))}</h1>); continue; }
    if (/^[A-Z][A-Z0-9 ·\-—/]{2,}$/.test(line) && paraBuf.length === 0) {
      nodes.push(<div key={`eb${nodes.length}`} className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500 mt-6">{line}</div>);
      continue;
    }
    paraBuf.push(line);
  }
  flushPara();
  return nodes;
}

export function renderInline(t) {
  const parts = [];
  let i = 0;
  // SECURITY: the `[text](url)` branch below puts an author-supplied URL straight into
  // `href` with no scheme validation. This was audited and is NOT an XSS vector: React 19
  // replaces `javascript:` URLs with a throwing stub (verified in the shipped react-dom
  // build), and the authors here are admins/editors who can already post links. Two
  // things would change that, so check them before altering this: rendering this markdown
  // outside React (an email template, SSR-to-string), or moving to a React version whose
  // URL scrubbing no longer applies. See SECURITY_AUDIT.md → "False alarms".
  // Bold/strike/underline before italic so `**`/`~~`/`__` aren't swallowed by the single-`*` pattern.
  const re = /\*\*(.+?)\*\*|~~(.+?)~~|__(.+?)__|\*(.+?)\*|\[(.+?)\]\((.+?)\)/g;
  let m;
  while ((m = re.exec(t))) {
    if (m.index > i) parts.push(t.slice(i, m.index));
    if (m[1] !== undefined) parts.push(<strong key={i} className="text-white">{m[1]}</strong>);
    else if (m[2] !== undefined) parts.push(<s key={i}>{m[2]}</s>);
    else if (m[3] !== undefined) parts.push(<u key={i}>{m[3]}</u>);
    else if (m[4] !== undefined) parts.push(<em key={i}>{m[4]}</em>);
    else if (m[5] !== undefined) parts.push(<a key={i} href={m[6]} className="underline underline-offset-4 hover:text-white">{m[5]}</a>);
    i = m.index + m[0].length;
  }
  if (i < t.length) parts.push(t.slice(i));
  return parts;
}

/** Wraps (or unwraps, if the selection is already wrapped) the current textarea
 * selection with `marker` on both sides. Falls back to wrapping nothing (cursor
 * position) when there's no selection, so typing continues between the markers. */
export function wrapTextareaSelection(textareaEl, value, onChange, marker) {
  if (!textareaEl) return;
  const start = textareaEl.selectionStart ?? value.length;
  const end = textareaEl.selectionEnd ?? value.length;
  const selected = value.slice(start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);
  const mLen = marker.length;
  const alreadyWrapped = before.endsWith(marker) && after.startsWith(marker);

  let next, selStart, selEnd;
  if (alreadyWrapped) {
    next = before.slice(0, -mLen) + selected + after.slice(mLen);
    selStart = start - mLen;
    selEnd = end - mLen;
  } else {
    next = before + marker + selected + marker + after;
    selStart = start + mLen;
    selEnd = end + mLen;
  }
  onChange(next);
  requestAnimationFrame(() => {
    textareaEl.focus();
    textareaEl.setSelectionRange(selStart, selEnd);
  });
}

const MARKS = [
  { marker: "**", label: "B", title: "Bold", className: "font-bold" },
  { marker: "*", label: "I", title: "Italic", className: "italic" },
  { marker: "__", label: "U", title: "Underline", className: "underline" },
  { marker: "~~", label: "S", title: "Strikethrough", className: "line-through" },
];

/** Bold/Italic/Underline/Strikethrough toolbar for a controlled textarea.
 * `textareaRef` must point at the same textarea rendering `value`. */
export function FormatToolbar({ textareaRef, value, onChange }) {
  return (
    <div className="flex gap-1 mb-1">
      {MARKS.map((m) => (
        <button key={m.marker} type="button" title={m.title}
                onClick={() => wrapTextareaSelection(textareaRef.current, value, onChange, m.marker)}
                className={`w-7 h-7 border border-white/20 text-xs hover:border-white hover:bg-white/5 ${m.className}`}>
          {m.label}
        </button>
      ))}
    </div>
  );
}
