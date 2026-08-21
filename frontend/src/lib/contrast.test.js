/**
 * Contrast maths, and the warning it drives in the theme editor.
 *
 * The reason this is tested rather than eyeballed: the theme editor lets a customer
 * type any colour into any slot, so the only thing standing between them and an
 * unreadable site is whether `failingPairs` actually notices. A warning that silently
 * returns nothing is worse than no warning, because it reads as a pass.
 */
import { luminance, contrastRatio, failingPairs, AA_TEXT } from "./contrast";
import { MODE_NEUTRALS } from "./cms";
import { presetPatch } from "./themePresets";

describe("luminance", () => {
  test("anchors at the ends of the range", () => {
    expect(luminance("#000000")).toBe(0);
    expect(luminance("#FFFFFF")).toBe(1);
  });

  test("reads the three forms the theme document stores", () => {
    expect(luminance("#fff")).toBe(1);
    expect(luminance("#FFFFFF")).toBe(1);
    expect(luminance("rgb(255, 255, 255)")).toBe(1);
    expect(luminance("rgba(255,255,255,0.1)")).toBe(1); // alpha ignored, by design
  });

  test("returns null rather than NaN for something it cannot read", () => {
    // A colour field accepts free text, so this is a real input, not a hypothetical.
    expect(luminance("rebeccapurple")).toBeNull();
    expect(luminance("")).toBeNull();
    expect(luminance(undefined)).toBeNull();
  });
});

describe("contrastRatio", () => {
  test("black on white is the maximum 21:1", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
  });

  test("a colour against itself is 1:1", () => {
    expect(contrastRatio("#FF3333", "#FF3333")).toBeCloseTo(1, 5);
  });

  test("order does not matter", () => {
    expect(contrastRatio("#DB0000", "#FFFFFF"))
      .toBeCloseTo(contrastRatio("#FFFFFF", "#DB0000"), 10);
  });

  test("null propagates instead of producing a confident wrong number", () => {
    expect(contrastRatio("nonsense", "#FFFFFF")).toBeNull();
  });
});

describe("failingPairs", () => {
  test("a passing palette reports nothing", () => {
    expect(failingPairs(presetPatch("light").colors)).toEqual([]);
    expect(failingPairs(presetPatch("dark").colors)).toEqual([]);
    expect(failingPairs(presetPatch("supersanity").colors)).toEqual([]);
  });

  test("catches the bug this module was written for", () => {
    // The original defect: the house red tuned for dark, printed on a white page.
    const broken = { ...presetPatch("light").colors, accent: "#FF3333", accentFg: "#000000" };
    const found = failingPairs(broken);
    expect(found.map((f) => f.label)).toContain("Accent as text");
    expect(found.find((f) => f.label === "Accent as text").ratio).toBeCloseTo(3.64, 1);
  });

  test("orders the worst offender first", () => {
    const awful = { ...presetPatch("light").colors, text: "#FEFEFE", accent: "#FF3333" };
    const found = failingPairs(awful);
    expect(found.length).toBeGreaterThan(1);
    expect(found[0].ratio).toBeLessThanOrEqual(found[1].ratio);
  });

  test("an unreadable colour is skipped, not reported as a failure", () => {
    // Mid-typing, a colour field holds things like "#DB00". Warning on those would
    // make the panel flash red on every keystroke.
    expect(failingPairs({ ...presetPatch("light").colors, accent: "#DB00" })).toEqual([]);
  });

  test("survives a missing or empty palette", () => {
    expect(failingPairs(null)).toEqual([]);
    expect(failingPairs({})).toEqual([]);
  });
});

describe("the light/dark mode flip", () => {
  /* The flip deliberately keeps the accent, so that a customer's own brand colour is
     not overwritten by switching mode. The cost is that a dark-tuned accent can land
     below AA on light — which is allowed, but must not be silent. */
  const flippedToLight = {
    ...presetPatch("dark").colors,
    ...MODE_NEUTRALS.light,
  };

  test("keeps the accent, as designed", () => {
    expect(flippedToLight.accent).toBe("#FF3333");
  });

  test("and is therefore reported as failing, rather than passing quietly", () => {
    const found = failingPairs(flippedToLight);
    expect(found.map((f) => f.label)).toContain("Accent as text");
  });

  test("while the Light preset is the one-click way out", () => {
    expect(failingPairs(presetPatch("light").colors)).toEqual([]);
    expect(contrastRatio(presetPatch("light").colors.accent, "#FFFFFF"))
      .toBeGreaterThanOrEqual(AA_TEXT);
  });
});
