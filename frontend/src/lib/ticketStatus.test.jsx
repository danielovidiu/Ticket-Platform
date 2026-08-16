/**
 * Admin list vocabularies: the ticket-status filters and the event status badge.
 *
 * No rendering here — these are the pure parts, and they are the parts that go wrong
 * silently. A missing entry in TICKET_STATUS_CLASS does not throw; it renders an
 * unstyled chip that nobody notices until a real cancelled event shows up.
 */
import { eventStatus, TICKET_FILTERS, TICKET_STATUS_CLASS } from "../lib/ticketStatus";

// Mirrors TICKET_STATUSES in backend/server.py. Duplicated on purpose rather than
// derived: if the two drift, this list is what makes the drift a test failure instead
// of a filter tab that quietly returns nothing. The backend has the matching guard
// (test_door_denial.py::TestStatusVocabularyMatchesTheUI).
const BACKEND_STATUSES = ["issued", "used", "denied", "cancelled", "refunded"];

describe("ticket status filters", () => {
  test("every backend status is offered as a filter", () => {
    const offered = TICKET_FILTERS.map(([value]) => value);
    for (const status of BACKEND_STATUSES) {
      expect(offered).toContain(status);
    }
  });

  test("no filter offers a status the backend cannot produce", () => {
    for (const [value] of TICKET_FILTERS) {
      if (value === "all") continue;
      expect(BACKEND_STATUSES).toContain(value);
    }
  });

  test("every status has a chip style", () => {
    // The failure this catches is cosmetic-looking and is not: an unstyled chip on a
    // `cancelled` ticket reads as an ordinary one, and cancelled means money is owed.
    for (const status of BACKEND_STATUSES) {
      expect(TICKET_STATUS_CLASS[status]).toBeTruthy();
    }
  });

  test("`all` leads, so the default view is unfiltered", () => {
    expect(TICKET_FILTERS[0][0]).toBe("all");
  });

  test("every filter has a human label", () => {
    for (const [, label] of TICKET_FILTERS) {
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe("event status badge", () => {
  const future = new Date(Date.now() + 864e5).toISOString();
  const past = new Date(Date.now() - 864e5).toISOString();

  test("an unpublished event is a draft whatever its dates say", () => {
    expect(eventStatus({ is_published: false, starts_at: future })).toBe("DRAFT");
    expect(eventStatus({ is_published: false, starts_at: past })).toBe("DRAFT");
  });

  test("a published future event is live", () => {
    expect(eventStatus({ is_published: true, starts_at: future })).toBe("LIVE");
  });

  test("a published finished event is past", () => {
    expect(eventStatus({ is_published: true, starts_at: past })).toBe("PAST");
  });

  test("ends_at decides it when present, not starts_at", () => {
    // A festival that started yesterday and runs until tomorrow is still LIVE — reading
    // starts_at alone would retire it a day early and hide it from the door.
    expect(eventStatus({ is_published: true, starts_at: past, ends_at: future })).toBe("LIVE");
  });
});
