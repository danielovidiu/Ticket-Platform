/**
 * How visible the footer is, from how far the page still has to go.
 *
 * The footer is a fixed overlay now, invisible for the whole page and fading in across
 * its last stretch, so a background photo or a video reaches the bottom of the screen
 * instead of stopping above a bar.
 *
 * All of the interesting behaviour is four lines of arithmetic with four edge cases, and
 * none of them need a browser — which is why the sum is a pure function and the DOM
 * plumbing is a separate hook. Two of these cases are the ones that would ship broken:
 * a page too short to scroll (the footer would never appear at all) and overscroll (an
 * opacity above 1).
 */
import { describe, test, expect } from "vitest";
import { revealOpacity, FADE_DISTANCE } from "./footerReveal";

/** A page `scrollHeight` tall, viewed through `innerHeight`, scrolled to `scrollY`. */
const at = (scrollY, { scrollHeight = 2000, innerHeight = 800, fade } = {}) =>
  revealOpacity({ scrollY, innerHeight, scrollHeight, fade });

describe("the reveal", () => {
  test("is invisible for the whole page until the end is near", () => {
    // 2000 tall, 800 window: the bottom is reached at scrollY 1200, so the fade starts
    // at 1050. Everything before that is untouched page.
    expect(at(0)).toBe(0);
    expect(at(600)).toBe(0);
    expect(at(1049)).toBeCloseTo(0, 2);
  });

  test("is solid at the bottom", () => {
    expect(at(1200)).toBe(1);
  });

  test("is halfway across the middle of the fade", () => {
    // 75px remaining out of a 150px window.
    expect(at(1125)).toBeCloseTo(0.5, 5);
  });

  test("rises without a jump across the whole window", () => {
    // Monotonic: any step towards the bottom must not make it less visible. A fade that
    // goes backwards anywhere reads as a flicker.
    let previous = -1;
    for (let y = 1040; y <= 1200; y += 5) {
      const now = at(y);
      expect(now).toBeGreaterThanOrEqual(previous);
      previous = now;
    }
    expect(previous).toBe(1);
  });
});

describe("the cases that would ship broken", () => {
  test("a page too short to scroll is already at its end", () => {
    // Otherwise the footer is invisible forever on exactly the pages where there is no
    // scrolling to reveal it — an empty gallery, a 404, a short legal page.
    expect(at(0, { scrollHeight: 700, innerHeight: 800 })).toBe(1);
  });

  test("a page exactly one screen tall counts as scrolled to the bottom", () => {
    expect(at(0, { scrollHeight: 800, innerHeight: 800 })).toBe(1);
  });

  test("overscroll does not push it past solid", () => {
    // iOS rubber-banding and a trackpad flick both scroll PAST the end, which makes the
    // remaining distance negative and, unclamped, an opacity above 1.
    expect(at(1400)).toBe(1);
    expect(at(1400)).toBeLessThanOrEqual(1);
  });

  test("a missing measurement shows the footer rather than hiding it", () => {
    // If the numbers cannot be read, the failure that leaves the footer visible is much
    // better than the one that hides it on every page.
    expect(revealOpacity({ scrollY: NaN, innerHeight: 800, scrollHeight: 2000 })).toBe(1);
  });

  test("a zero-length fade snaps instead of dividing by zero", () => {
    expect(at(1100, { fade: 0 })).toBe(0);
    expect(at(1200, { fade: 0 })).toBe(1);
  });
});

describe("the window", () => {
  test("is measured in pixels, so it feels the same on a long page as a short one", () => {
    // 150px from the bottom is 150px from the bottom whether the page is two screens or
    // forty. A fraction of the page would make the reveal a different length on each.
    const shortPage = at(1050, { scrollHeight: 2000, innerHeight: 800 });
    const longPage = at(39_050, { scrollHeight: 40_000, innerHeight: 800 });
    expect(shortPage).toBeCloseTo(longPage, 5);
  });

  test("the default is the documented one", () => {
    expect(FADE_DISTANCE).toBe(150);
    expect(at(1200 - FADE_DISTANCE)).toBeCloseTo(0, 5);
  });
});
