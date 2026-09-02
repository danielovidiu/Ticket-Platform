/**
 * The footer's columns are found, not fixed.
 *
 * Shrinking the footer meant putting its four blocks two to a row on a phone instead of
 * stacking them: at 375px that took it from 445px to 281px, because a single column paid
 * three 40px gaps and a pair pays one.
 *
 * The obvious way to write that is `grid-cols-2`, and it is wrong. The constraint is not
 * the width available, it is the WORDMARK: "Supersanity" measures 157px and is a single
 * word, so it cannot wrap. Two columns at 375px leave it 159.5px — a margin of 2.5px, on
 * a whitelabel product where the next deployment's name is a different length. That
 * layout would not be responsive, it would be one that happens to fit one string.
 *
 * `auto-fit` with a floor lets the browser answer instead: two columns at 375, one at
 * 320, four at 1400, and never a column too narrow for what is in it. Verified in a
 * browser across 320/375/414/768/1440 with no clipped text at any of them.
 *
 * Asserted against the source because jsdom has no layout: it cannot measure a wordmark,
 * so it cannot catch the regression this is here to prevent. What it can do is notice
 * that the floor was removed.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "Layout.jsx"), "utf8");

/** The footer's own grid line — the one carrying the four columns. */
const footerGrid = () =>
  SRC.split("\n").find((l) => l.includes("grid") && l.includes("lg:grid-cols-4")) ?? "";

describe("footer columns", () => {
  test("the column count is driven by a minimum width, not hard-coded", () => {
    const line = footerGrid();
    expect(line, "could not find the footer grid line").not.toBe("");
    expect(
      line,
      "the footer must size its columns with auto-fit + a minmax floor. A fixed " +
      "grid-cols-N clips the wordmark on narrow phones — it is a single unbreakable " +
      "word, and its length changes per whitelabel deployment"
    ).toMatch(/repeat\(auto-fit,\s*minmax\(\d+px,\s*1fr\)\)/);
  });

  test("the floor is wide enough for a wordmark, and not so wide it never pairs", () => {
    // Below ~140px the columns stop fitting the copyright line; above ~165px a 375px
    // phone can no longer make two of them, which is the whole point of the change.
    const [, floor] = footerGrid().match(/minmax\((\d+)px/) ?? [];
    expect(Number(floor)).toBeGreaterThanOrEqual(140);
    expect(Number(floor)).toBeLessThanOrEqual(165);
  });

  test("four columns remain the cap on a wide screen", () => {
    // Without this, auto-fit would keep going: at 1400px a 150px floor allows eight.
    expect(footerGrid()).toMatch(/lg:grid-cols-4/);
  });

  test("the wordmark can break rather than overflow", () => {
    // The last resort behind the floor. A brand name that wraps is survivable; one
    // sliced off at the column edge is not.
    const wordmark = SRC.split("\n").find((l) => l.includes("s.wordmark"));
    expect(wordmark).toMatch(/break-words/);
  });
});
