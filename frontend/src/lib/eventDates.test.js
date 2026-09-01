/**
 * The event form's derived dates.
 *
 * These are guesses the form makes so an editor does not type the same night three
 * times. Each one is only right if it lands on the moment a person would have typed,
 * which is why the awkward cases — a show at 23:00, a show on the 31st, a show on New
 * Year's Eve — are the ones worth pinning.
 */
import { nextMorningAt6, doorsFrom, dayBefore, isPast } from "./eventDates";

// Local time throughout: an editor typing "6 a.m." means six in the venue's morning.
const at = (y, m, d, h = 0, min = 0) => new Date(y, m, d, h, min, 0, 0).toISOString();

describe("nextMorningAt6", () => {
  test("is the following morning at six", () => {
    expect(nextMorningAt6(at(2026, 8, 14, 21, 0))).toBe(at(2026, 8, 15, 6, 0));
  });

  test("a show starting after midnight still ends the next morning", () => {
    expect(nextMorningAt6(at(2026, 8, 15, 1, 30))).toBe(at(2026, 8, 16, 6, 0));
  });

  test("rolls over the end of a month", () => {
    expect(nextMorningAt6(at(2026, 0, 31, 22, 0))).toBe(at(2026, 1, 1, 6, 0));
  });

  test("rolls over the end of a year", () => {
    expect(nextMorningAt6(at(2026, 11, 31, 23, 0))).toBe(at(2027, 0, 1, 6, 0));
  });

  test("nothing in, nothing out", () => {
    expect(nextMorningAt6("")).toBe("");
    expect(nextMorningAt6(null)).toBe("");
    expect(nextMorningAt6("not a date")).toBe("");
  });
});

describe("doorsFrom", () => {
  test("is the moment the event starts", () => {
    const starts = at(2026, 8, 14, 21, 0);
    expect(doorsFrom(starts)).toBe(starts);
  });

  test("nothing in, nothing out", () => {
    expect(doorsFrom("")).toBe("");
  });
});

describe("dayBefore", () => {
  test("keeps the time of day rather than rounding to midnight", () => {
    // A 21:00 show stops selling at 21:00 the night before. Rounding down to midnight
    // would quietly cost the promoter a day of sales.
    expect(dayBefore(at(2026, 8, 14, 21, 0))).toBe(at(2026, 8, 13, 21, 0));
  });

  test("rolls back over the start of a month", () => {
    expect(dayBefore(at(2026, 2, 1, 20, 0))).toBe(at(2026, 1, 28, 20, 0));
  });

  test("nothing in, nothing out", () => {
    expect(dayBefore("")).toBe("");
  });
});

describe("isPast", () => {
  const now = new Date(2026, 8, 14, 12, 0, 0);

  test("yesterday is", () => {
    expect(isPast(at(2026, 8, 13, 21, 0), now)).toBe(true);
  });

  test("tomorrow is not", () => {
    expect(isPast(at(2026, 8, 15, 21, 0), now)).toBe(false);
  });

  test("an empty date is not past — it is unset, which is a different thing", () => {
    expect(isPast("", now)).toBe(false);
    expect(isPast(null, now)).toBe(false);
  });
});
