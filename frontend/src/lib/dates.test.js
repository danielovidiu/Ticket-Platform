/**
 * The album date label, and the timezone bug it exists to avoid.
 *
 * `new Date("2026-08-01")` is UTC midnight. Anywhere west of Greenwich that is still
 * 31 July locally, so the obvious one-liner renders a 1 August album as "Jul-26" — for
 * some readers, on some dates, and never on the developer's machine if they happen to
 * sit east of it.
 */
import { monthYear, shortDate, longDate, numericDate, dateTime } from "./dates";

describe("monthYear", () => {
  test("formats a day as LLL-YY", () => {
    expect(monthYear("2026-08-15")).toBe("Aug-26");
    expect(monthYear("2025-01-02")).toBe("Jan-25");
    expect(monthYear("1999-12-31")).toBe("Dec-99");
  });

  test("the first of the month does not slip into the month before", () => {
    // The whole reason the string is taken apart by hand instead of being handed to
    // `new Date`. This is the case that breaks under a negative UTC offset.
    expect(monthYear("2026-08-01")).toBe("Aug-26");
    expect(monthYear("2026-01-01")).toBe("Jan-26");
  });

  test("an album with no date gets no label rather than 'Invalid Date'", () => {
    expect(monthYear("")).toBe("");
    expect(monthYear(null)).toBe("");
    expect(monthYear(undefined)).toBe("");
  });

  test("rejects values that look like a day and are not one", () => {
    expect(monthYear("2026-02-31")).toBe(""); // shape is right; the day does not exist
    expect(monthYear("2026-13-01")).toBe("");
    expect(monthYear("2026-08")).toBe("");
    expect(monthYear("15 August 2026")).toBe("");
  });
});

/**
 * The four instant formatters, gathered here from nine inline copies across seven files.
 *
 * An explicit ISO instant with a Z offset is used throughout rather than a bare
 * "2026-09-02": these four go through `new Date(value)`, which reads a bare day as UTC
 * midnight, so a bare string would make the expected output depend on where the test runs.
 * Midday UTC is far enough from either boundary that every real timezone agrees on the day.
 */
describe("the instant formatters", () => {
  const noon = "2026-08-02T12:00:00Z";

  test("each writes its own shape", () => {
    expect(shortDate(noon)).toBe("02 AUG 2026");
    expect(longDate(noon)).toBe("02 AUGUST 2026");
    expect(numericDate(noon)).toBe("02/08/2026");
    // dateTime carries a time of day, whose separator differs between ICU versions —
    // asserting the date half and the presence of a clock is the stable claim.
    expect(dateTime(noon)).toContain("02/08/2026");
    expect(dateTime(noon)).toMatch(/\d{2}:\d{2}/);
  });

  test("the short month is whatever en-GB says it is, not three letters", () => {
    // September abbreviates to "Sept" in this locale, not "Sep". Asserted rather than
    // worked around: it is the output the site has always had, and pinning it here means
    // an ICU change that moves it shows up in a test instead of on the events grid.
    expect(shortDate("2026-09-02T12:00:00Z")).toBe("02 SEPT 2026");
  });

  test("nothing renders the string 'Invalid Date'", () => {
    // This is the behaviour change that came with the consolidation. Only one of the
    // nine inline copies guarded its input, so an event saved without a start date
    // printed "INVALID DATE" on the events grid.
    for (const fmt of [shortDate, longDate, numericDate, dateTime]) {
      expect(fmt("")).toBe("");
      expect(fmt(null)).toBe("");
      expect(fmt(undefined)).toBe("");
      expect(fmt("not a date")).toBe("");
    }
  });
});
