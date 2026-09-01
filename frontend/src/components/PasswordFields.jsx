import { useId, useState } from "react";
import { requirements } from "../lib/passwordPolicy";

/**
 * Choosing a password: the field, the retype, and what the rules are.
 *
 * Shared by the reset page and the registration form because those are the only two
 * places a password is set, and they used to disagree about what one had to look like —
 * a single field each, one client-side length check each, written out twice.
 *
 * Three decisions worth stating:
 *
 *   * THE RETYPE EXISTS BECAUSE THE FIELD IS MASKED. A typo in a password you cannot see
 *     is not discovered at the keyboard, it is discovered at the next sign-in, by which
 *     time the only way back is the reset link you just consumed.
 *   * THE RULES ARE SHOWN BEFORE THEY ARE BROKEN, all of them, from the first keystroke.
 *     A form that reveals one rule per rejection is a form people submit five times, and
 *     the fifth attempt is where they give up and pick something worse than they meant to.
 *   * PASTE IS NOT BLOCKED and autoComplete is "new-password", so a password manager can
 *     generate and fill. Blocking paste is a habit that only ever pushes people towards
 *     passwords short enough to type twice by hand.
 *
 * The checklist mirrors the server and is not the authority: the breach lookup needs a
 * network call the client cannot make, so a password can tick every box here and still
 * be refused on submit. The caller keeps showing server errors.
 */
export default function PasswordFields({
  value,
  onChange,
  confirm,
  onConfirmChange,
  identity = {},
  label = "New password",
  testId = "password",
}) {
  const [shown, setShown] = useState(false);
  const listId = useId();
  const rules = requirements(value, identity);
  // Silent until there is something to compare: a mismatch warning on an empty second
  // field is telling someone off for not having finished typing.
  const mismatch = confirm.length > 0 && value !== confirm;
  const matched = confirm.length > 0 && value === confirm;

  return (
    <div className="space-y-3" data-testid={`${testId}-fields`}>
      <div>
        <div className="flex items-center justify-between mb-1">
          <label htmlFor={`${listId}-pw`} className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4">
            {label}
          </label>
          <button type="button" onClick={() => setShown((s) => !s)}
                  data-testid={`${testId}-toggle`}
                  className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-3 hover:text-ink">
            {shown ? "Hide" : "Show"}
          </button>
        </div>
        <input
          id={`${listId}-pw`}
          type={shown ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="new-password"
          aria-describedby={listId}
          placeholder={label}
          data-testid={testId}
          className="input-x w-full"
        />
      </div>

      <div>
        <label htmlFor={`${listId}-confirm`} className="block font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 mb-1">
          Retype it
        </label>
        <input
          id={`${listId}-confirm`}
          type={shown ? "text" : "password"}
          value={confirm}
          onChange={(e) => onConfirmChange(e.target.value)}
          autoComplete="new-password"
          aria-invalid={mismatch || undefined}
          placeholder="Retype the password"
          data-testid={`${testId}-confirm`}
          className={`input-x w-full ${mismatch ? "border-brand" : ""}`}
        />
        {mismatch && (
          <div className="mt-1 font-mono-x text-[10px] uppercase tracking-[0.2em] text-brand"
               data-testid={`${testId}-mismatch`}>
            The two do not match
          </div>
        )}
        {matched && (
          <div className="mt-1 font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4"
               data-testid={`${testId}-matched`}>
            Match
          </div>
        )}
      </div>

      <ul id={listId} className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1"
          data-testid={`${testId}-requirements`}>
        {rules.map((r) => (
          <li key={r.id} data-testid={`${testId}-rule-${r.id}`} data-ok={r.ok ? "yes" : "no"}
              className={`font-mono-x text-[10px] uppercase tracking-[0.15em] flex items-center gap-2 ${
                r.ok ? "text-ink-2" : "text-ink-4"}`}>
            <span aria-hidden="true" className="w-3 shrink-0">{r.ok ? "✓" : "·"}</span>
            <span>{r.label}</span>
            <span className="sr-only">{r.ok ? "met" : "not met"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
