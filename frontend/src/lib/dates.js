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

/**
 * The four shapes an instant is written in on this site.
 *
 * These were nine inline `toLocaleDateString("en-GB", {...})` calls spread across seven
 * files — the "02 SEP 2026" literal alone appeared three times, character for character,
 * so a change to how an event's date reads meant finding all three. They are gathered
 * here because this is already the module that owns that question.
 *
 * Every one of them refuses a value it cannot read, returning "" rather than the string
 * "Invalid Date". That was NOT the previous behaviour: only the copy in the (now deleted)
 * Home page guarded its input, so an event with an empty `starts_at` printed
 * "INVALID DATE" on the events grid. `monthYear` above has always worked this way, and
 * one module should not disagree with itself about what an unreadable date looks like.
 *
 * en-GB throughout, not the reader's locale. The site is sold and run in one city and
 * the copy around these dates is written in English; a US visitor seeing "SEP 02" beside
 * prose that says "on the 2nd" is a worse outcome than a fixed order everyone can read.
 */
const at = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "02 SEP 2026" — the events grid, the block renderer, an event card. */
export const shortDate = (value) => {
  const d = at(value);
  return d ? d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase() : "";
};

/** "02 SEPTEMBER 2026" — the event page's own headline date, where there is room for it. */
export const longDate = (value) => {
  const d = at(value);
  return d ? d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" }).toUpperCase() : "";
};

/** "02/09/2026" — beside an invoice or an order number, where the date is a reference
 *  rather than something being announced. */
export const numericDate = (value) => {
  const d = at(value);
  return d ? d.toLocaleDateString("en-GB") : "";
};

/** "02/09/2026, 23:15" — the admin tables, where the time of day is the point. */
export const dateTime = (value) => {
  const d = at(value);
  return d ? d.toLocaleString("en-GB") : "";
};
