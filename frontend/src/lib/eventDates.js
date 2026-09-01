/** The dates an event's form fills in for itself once you say when it starts.
 *
 * All three derive from `starts_at` and all three stay editable — they are a first
 * guess at the shape of a night, not a rule. Every helper takes and returns an ISO
 * string, which is what the pickers and the backend both speak, and returns "" for
 * anything it cannot read rather than an Invalid Date that reaches the API.
 */

const parse = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** The morning after, at 06:00 — where a night that starts at 23:00 actually ends.
 *
 * Built in local time on purpose. These events are sold and run in one city, and an
 * editor typing "6 a.m." means six in the morning where the venue is, not 06:00 UTC.
 */
export function nextMorningAt6(startsAt) {
  const d = parse(startsAt);
  if (!d) return "";
  const next = new Date(d);
  // setDate rolls the month and the year over on its own, so the 31st is safe.
  next.setDate(next.getDate() + 1);
  next.setHours(6, 0, 0, 0);
  return next.toISOString();
}

/** Doors open when the event starts, unless someone says otherwise. */
export function doorsFrom(startsAt) {
  const d = parse(startsAt);
  return d ? d.toISOString() : "";
}

/** The day before the event — when a tier stops selling by default.
 *
 * A flat 24 hours back, not "the previous calendar day at midnight": subtracting a day
 * from a 21:00 show gives 21:00 the night before, which is a sale window an editor can
 * reason about. Rounding to midnight would silently cost them a day of sales.
 */
export function dayBefore(startsAt) {
  const d = parse(startsAt);
  if (!d) return "";
  return new Date(d.getTime() - 24 * 60 * 60 * 1000).toISOString();
}

/** Whether a moment has already been and gone. Used to warn, never to refuse: an event
 * may legitimately be entered after the fact, and the editor is told rather than
 * stopped. */
export function isPast(iso, now = new Date()) {
  const d = parse(iso);
  return d ? d.getTime() < now.getTime() : false;
}
