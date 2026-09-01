/**
 * The album date label, and the timezone bug it exists to avoid.
 *
 * `new Date("2026-08-01")` is UTC midnight. Anywhere west of Greenwich that is still
 * 31 July locally, so the obvious one-liner renders a 1 August album as "Jul-26" — for
 * some readers, on some dates, and never on the developer's machine if they happen to
 * sit east of it.
 */
import { monthYear } from "./dates";

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
