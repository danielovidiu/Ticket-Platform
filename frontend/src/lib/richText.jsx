
/**
 * Shared markdown-ish subset used everywhere free text is entered: event descriptions,
 * artist bios, project descriptions, and CMS body/content fields. Deliberately not full
 * CommonMark — just enough to back the formatting toolbar (see FormatToolbar /
 * wrapTextareaSelection below).
 *
 * Block level: #/##/### headings, `-`/`*`/`1.` lists, blank-line paragraphs.
 * Inline: **bold**, *italic*, ~~strikethrough~~, __underline__, [text](url).
 * (Markdown has no native underline mark — `__x__` is repurposed for it here since this
 * subset doesn't use `__` for anything else.)
 *
 * WHAT THIS RENDERER GUARANTEES, and did not before:
 *
 *   * a single newline is a LINE BREAK, not a space. Lines inside a paragraph used to be
 *     `join(" ")`-ed, so an address or a set of credits came out as one run-on line.
 *   * blank lines survive. One separates paragraphs; further ones are kept as spacing,
 *     rather than every run of them collapsing to the same gap.
 *   * leading indentation survives, via `white-space: pre-wrap` on the paragraph.
 *   * nothing is reinterpreted by its casing. An ALL-CAPS line used to be silently
 *     promoted to a styled eyebrow, so an author who shouted one line got a different
 *     element than the one they wrote — the clearest case of the CMS editing the author.
 */

/** Text nodes plus <br>, so a newline inside a paragraph renders as a newline. */
function withLineBreaks(text, keyBase) {
  const lines = text.split("\n");
  const out = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(<br key={`${keyBase}-br${i}`} />);
    out.push(<span key={`${keyBase}-l${i}`}>{renderInline(line)}</span>);
  });
  return out;
}

const LIST_ITEM = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;

export function renderRich(md, opts = {}) {
  if (!md) return null;
  // `whitespace-pre-wrap` is what keeps an author's indentation and runs of spaces —
  // the CSS default would collapse both no matter how carefully the text is preserved
  // on the way here.
  const paraClassName = opts.paraClassName || "text-ink-2 text-lg leading-relaxed max-w-2xl mt-4";
  // Lists take the same overrides as paragraphs. They used to be hardcoded, which meant a
  // caller that widened its paragraphs got bullets still capped at max-w-2xl — prose and
  // list in the same block, at two different measures.
  const listClassName = opts.listClassName || "mt-4 space-y-1 text-ink-2 text-lg leading-relaxed max-w-2xl";
  const lines = String(md).split(/\n/);
  const nodes = [];
  let paraBuf = [];
  let listBuf = null; // { ordered, items: [] }

  const flushPara = () => {
    if (paraBuf.length === 0) return;
    const text = paraBuf.join("\n");
    nodes.push(
      <p key={`p${nodes.length}`} className={`${paraClassName} whitespace-pre-wrap`}>
        {withLineBreaks(text, `p${nodes.length}`)}
      </p>
    );
    paraBuf = [];
  };

  const flushList = () => {
    if (!listBuf) return;
    const Tag = listBuf.ordered ? "ol" : "ul";
    nodes.push(
      <Tag key={`l${nodes.length}`}
           className={`${listBuf.ordered ? "list-decimal" : "list-disc"} pl-6 ${listClassName}`}>
        {listBuf.items.map((item, i) => (
          <li key={i} className="whitespace-pre-wrap">{renderInline(item)}</li>
        ))}
      </Tag>
    );
    listBuf = null;
  };

  const flushAll = () => { flushPara(); flushList(); };

  const heading = (line, level, className) => {
    flushAll();
    const Tag = `h${level}`;
    nodes.push(<Tag key={`h${nodes.length}`} className={className}>{renderInline(line)}</Tag>);
  };

  for (const raw of lines) {
    // Only the trailing newline is stripped; leading whitespace is the author's.
    const line = raw.replace(/\s+$/, "");

    if (line === "") {
      // A blank line ends whatever was open. A SECOND consecutive blank is deliberate
      // spacing rather than a no-op, so it is kept as an empty paragraph.
      if (paraBuf.length === 0 && !listBuf && nodes.length > 0) {
        nodes.push(<p key={`sp${nodes.length}`} className={`${paraClassName} whitespace-pre-wrap`} aria-hidden="true">{"\u00a0"}</p>);
      } else {
        flushAll();
      }
      continue;
    }

    const trimmed = line.trimStart();
    if (trimmed.startsWith("### ")) { heading(trimmed.slice(4), 3, "font-display text-2xl md:text-3xl font-bold tracking-tight mt-8"); continue; }
    if (trimmed.startsWith("## ")) { heading(trimmed.slice(3), 2, "font-display text-3xl md:text-5xl font-bold tracking-tighter mt-10"); continue; }
    if (trimmed.startsWith("# ")) { heading(trimmed.slice(2), 1, "font-display text-5xl md:text-7xl font-black tracking-tighter mt-4 leading-[0.9]"); continue; }

    const li = LIST_ITEM.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]);
      flushPara();
      if (listBuf && listBuf.ordered !== ordered) flushList();
      if (!listBuf) listBuf = { ordered, items: [] };
      listBuf.items.push(li[3]);
      continue;
    }

    flushList();
    paraBuf.push(line);
  }
  flushAll();
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
    if (m[1] !== undefined) parts.push(<strong key={i} className="text-ink">{m[1]}</strong>);
    else if (m[2] !== undefined) parts.push(<s key={i}>{m[2]}</s>);
    else if (m[3] !== undefined) parts.push(<u key={i}>{m[3]}</u>);
    else if (m[4] !== undefined) parts.push(<em key={i}>{m[4]}</em>);
    else if (m[5] !== undefined) parts.push(<a key={i} href={m[6]} className="underline underline-offset-4 hover:text-ink">{m[5]}</a>);
    i = m.index + m[0].length;
  }
  if (i < t.length) parts.push(t.slice(i));
  return parts;
}

/**
 * The same text with every mark taken off — headings, list bullets, emphasis, and the
 * label out of a `[text](url)` link. Newlines collapse to single spaces.
 *
 * This is what an excerpt has to be built from. Slicing the markdown source directly
 * cuts through `**bold**` and `[label](url)` and renders the wreckage, and the cut lands
 * in a different place than the reader counts it — a 200-character limit that spends 30
 * of them on syntax the reader never sees is not a 200-character limit.
 */
export function richToPlain(md) {
  if (!md) return "";
  return String(md)
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")               // headings
    .replace(/^\s*([-*]|\d+[.)])\s+/gm, "")           // list bullets
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1")             // links -> their label
    .replace(/(\*\*|~~|__)(.+?)\1/g, "$2")            // bold / strike / underline
    .replace(/\*(.+?)\*/g, "$1")                      // italic
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * `text` cut to at most `limit` characters on a word boundary, plus whether anything
 * was left behind. The caller needs both: a "see more" control that appears when there
 * is nothing more to see is worse than no control at all.
 */
export function excerpt(md, limit = 200) {
  const plain = richToPlain(md);
  if (plain.length <= limit) return { text: plain, truncated: false };
  const cut = plain.slice(0, limit);
  // Back up to the last space so the excerpt doesn't end mid-word. If there isn't one
  // (a single very long token), take the hard cut rather than returning nothing.
  const space = cut.lastIndexOf(" ");
  return { text: (space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd(), truncated: true };
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
                className={`w-7 h-7 border border-ink/20 text-xs hover:border-ink hover:bg-ink/5 ${m.className}`}>
          {m.label}
        </button>
      ))}
    </div>
  );
}
