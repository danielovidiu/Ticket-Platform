import { format } from "date-fns";

/** An album's date as it appears beside its title: "Aug-26".
 *
 * The stored value is a plain YYYY-MM-DD day, and it is taken apart by hand rather than
 * handed to `new Date(value)`. That constructor reads a bare date string as UTC
 * midnight, so anywhere west of Greenwich a 1 August album renders as July — a
 * one-character-wide bug that only appears for readers in the wrong timezone and only
 * on the first of a month. Building the date from its parts makes it local by
 * construction, and the day never moves.
 *
 * Anything that is not a day at all returns "" rather than "Invalid Date", so a tile
 * with no date simply shows its title.
 */
export function monthYear(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!m) return "";
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const parsed = new Date(y, mo - 1, d);
  // Rejects the dates that pass the pattern and are not days: 2026-02-31 rolls over
  // into March, and the mismatch is how that shows up.
  if (parsed.getFullYear() !== y || parsed.getMonth() !== mo - 1 || parsed.getDate() !== d) return "";
  return format(parsed, "MMM-yy");
}
