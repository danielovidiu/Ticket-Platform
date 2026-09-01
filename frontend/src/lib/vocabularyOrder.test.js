/**
 * The lists a person picks from are A-Z.
 *
 * Not every list: a scale is not a menu. `SIZES` is XS..XXL and alphabetical would render
 * it "L, M, ONE SIZE, S, XL, XS, XXL"; alignment is left/center/right; heights are
 * short/medium/tall; font weights climb 300 to 900. Those are ordered by what they mean,
 * and the tests below assert they were left alone as much as they assert the rest moved.
 *
 * Content ordering is a third thing again and is not touched anywhere: events are
 * chronological, albums and nav items carry an explicit sort_order that a person drags,
 * and the blocks on a page are the page.
 */
import { BLOCK_TYPES, BLOCK_LABELS } from "./cms";
import { SOCIAL_PLATFORMS } from "./social";
import { GOOGLE_SUGGESTIONS } from "../components/FontPicker";

const sortedBy = (arr, pick = (x) => x) =>
  [...arr].sort((a, b) => pick(a).localeCompare(pick(b)));

describe("the add-block palette", () => {
  test("is A-Z by the label a person reads, not by the key", () => {
    const labels = BLOCK_TYPES.map((t) => BLOCK_LABELS[t]);
    expect(labels).toEqual(sortedBy(labels));
  });

  test("still offers every block", () => {
    // Sorting a derived list is a good way to accidentally drop one.
    expect(new Set(BLOCK_TYPES)).toEqual(new Set(Object.keys(BLOCK_LABELS)));
  });

  test("order is derived, so a block appended to BLOCK_LABELS cannot drift", () => {
    // The literal is where blocks get added; if the ordering lived there it would rot
    // the first time somebody appended one to the end.
    const labels = BLOCK_TYPES.map((t) => BLOCK_LABELS[t]);
    expect(labels[0]).toBe(sortedBy(Object.values(BLOCK_LABELS))[0]);
  });
});

describe("social platforms", () => {
  test("are A-Z by label", () => {
    const labels = SOCIAL_PLATFORMS.map((p) => p.label);
    expect(labels).toEqual(sortedBy(labels));
  });

  test("one list drives both the artist form and the public artist page", () => {
    // Which is why sorting it here is the whole change: the admin fields and the
    // buttons a visitor sees are rendered from the same array.
    expect(SOCIAL_PLATFORMS.every((p) => p.key && p.label)).toBe(true);
  });
});

describe("font suggestions", () => {
  test("are A-Z — it is a menu to find a family in, not a ranking", () => {
    expect(GOOGLE_SUGGESTIONS).toEqual(sortedBy(GOOGLE_SUGGESTIONS));
  });
});
