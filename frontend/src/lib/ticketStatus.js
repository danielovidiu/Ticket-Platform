/**
 * The admin list vocabularies: what an event's badge says, and what a ticket's does.
 *
 * Pulled out of Admin.jsx because these are pure data and pure logic, and because that
 * page imports react-router-dom — whose v7 ESM entry point jest's resolver cannot read,
 * so anything living beside it is untestable in practice.
 */

export function eventStatus(e) {
  if (!e.is_published) return "DRAFT";
  const endMoment = e.ends_at || e.starts_at;
  return new Date(endMoment) < new Date() ? "PAST" : "LIVE";
}

export const STATUS_CLASS = {
  LIVE: "text-ok",
  PAST: "text-ink-4",
  DRAFT: "text-brand",
};

// Mirrors TICKET_STATUSES in backend/server.py. The two runtimes cannot share a
// constant, so drift is guarded from both sides — Admin.test.jsx here, and
// test_door_denial.py::TestStatusVocabularyMatchesTheUI on the backend.
export const TICKET_FILTERS = [
  ["all", "All"],
  ["issued", "Issued"],
  ["used", "Used"],
  ["denied", "Denied"],
  ["cancelled", "Cancelled"],
  ["refunded", "Refunded"],
];

export const TICKET_STATUS_CLASS = {
  issued: "border-ink/20 text-ink-2",
  used: "border-ok/50 text-ok",
  denied: "border-brand/60 text-brand",
  // Solid rather than outlined, and louder than a denial on purpose: one guest refused at
  // the door is a decision, a cancelled show is money the platform owes every holder.
  // (There is no `warn` token in the palette — page/ink/brand/ok/line is the whole set —
  // so this is weight, not a new hue.)
  cancelled: "bg-brand text-brand-fg border-brand",
  refunded: "border-ink/20 text-ink-4",
};
