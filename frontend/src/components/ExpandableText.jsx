import { useState } from "react";
import { excerpt } from "../lib/richText";

/**
 * A block of prose that starts short and offers the rest.
 *
 * The artist bio has worked this way for a while; album descriptions now do too, and
 * the second one is what made this a component rather than a second copy. The two are
 * not identical — different lengths, and one renders markdown while the other does not —
 * so what is shared is the part that is genuinely the same: decide whether there IS more,
 * show an excerpt if so, and offer one control that says which way it goes.
 *
 * WHY THE COLLAPSED STATE IS PLAIN TEXT. It comes from `excerpt`, which strips the marks
 * before counting. Slicing markdown at 400 characters cuts through `**bold**` and
 * `[label](url)` and renders the wreckage — and the cut lands somewhere the reader did
 * not count, because a limit that spends 30 characters on syntax nobody sees is not the
 * limit it claims to be.
 *
 * The control appears ONLY when something is actually hidden. A "see more" that expands
 * to the same words is worse than no control at all.
 */
export default function ExpandableText({
  text,
  limit,
  className = "",
  paraClassName = "",
  testId,
  /** How the FULL text is drawn once opened. Defaults to a plain paragraph that keeps
   *  the author's line breaks; the artist bio passes the rich renderer instead. */
  renderExpanded,
}) {
  const [open, setOpen] = useState(false);
  if (!text) return null;

  const draw = renderExpanded || ((value) => (
    <p className={`${paraClassName} whitespace-pre-wrap`}>{value}</p>
  ));

  const { text: short, truncated } = excerpt(text, limit);

  // Nothing is hidden, so there is nothing to offer. Rendered without the wrapper's
  // toggle rather than with a disabled one.
  if (!truncated) {
    return <div className={className} data-testid={testId}>{draw(text)}</div>;
  }

  return (
    <div className={className} data-testid={testId}>
      {open ? draw(text) : <p className={paraClassName}>{short}…</p>}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        data-testid={testId ? `${testId}-toggle` : undefined}
        className="mt-3 font-mono-x text-xs uppercase tracking-[0.3em] text-ink-3 hover:text-ink underline underline-offset-4"
      >
        {open ? "See less" : "See more"}
      </button>
    </div>
  );
}
