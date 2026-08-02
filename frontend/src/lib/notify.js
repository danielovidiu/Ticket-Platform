import React from "react";
import { toast } from "sonner";

/**
 * An error toast the whole surface of which dismisses it.
 *
 * sonner 2.x has no click-to-dismiss: a toast can carry a small × (`closeButton`) or be
 * swiped away, and neither is a comfortable target on a phone — someone who mistypes a
 * password gets a message they have to either wait out or hit precisely. `toast.custom`
 * is the only way to own the whole node, so the styling that normally comes from the
 * <Toaster> defaults is repeated here to match.
 *
 * Rendered as a <button> rather than a <div onClick>: keyboard focus, Enter/Space and
 * the announcement all come for free, which a clickable div would each need spelling out.
 */
export function notifyError(message, options = {}) {
  return toast.custom(
    (id) => (
      <button
        type="button"
        onClick={() => toast.dismiss(id)}
        data-testid="toast-error"
        aria-label={`${message}. Tap to dismiss.`}
        className="w-full text-left bg-page border border-brand text-ink px-4 py-3 cursor-pointer select-none"
      >
        <span className="block text-sm leading-snug">{message}</span>
        <span className="block font-mono-x text-[9px] uppercase tracking-[0.25em] text-ink-4 mt-1">
          Tap to dismiss
        </span>
      </button>
    ),
    options,
  );
}
