import { Link } from "react-router-dom";

/**
 * The way back to the index a detail page came from: top left, above the title.
 *
 * It reads before the content rather than after it. A link at the foot of an artist's
 * page was only reachable by scrolling past everything the visitor had just decided they
 * did not want, which is the one case where they most want out — and on the event and
 * product pages there was no way back at all short of the browser's own button.
 *
 * Deliberately quiet type: this is an escape hatch, not a call to action, and it sits
 * directly above a heading it must not compete with.
 */
export default function BackLink({ to, children, testId }) {
  return (
    <Link to={to} data-testid={testId}
          className="inline-block font-mono-x text-[10px] uppercase tracking-[0.25em] text-ink-4 hover:text-ink">
      ← {children}
    </Link>
  );
}
