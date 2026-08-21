/**
 * The theme presets.
 *
 * Two things are worth a test here, and neither is that the objects exist.
 *
 * The first is contrast. A preset ships a palette nobody reviews again once it is in
 * the picker, and the failure mode is silent: text that is merely hard to read looks
 * fine to whoever chose the colours on a good monitor. The ratios below are the
 * WCAG AA thresholds, checked against the ground each colour is actually printed on.
 *
 * The second is that `presetIdFor` is honest. It drives a label that tells the editor
 * which palette they are looking at, so a false positive is a lie about the state of
 * the document.
 */
import { THEME_PRESETS, presetIdFor, presetPatch } from "./themePresets";
import { luminance, contrastRatio as contrast } from "./contrast";

describe.each(THEME_PRESETS)("$label", ({ theme }) => {
  const c = theme.colors;

  test("body text clears AA on the page", () => {
    expect(contrast(c.text, c.bg)).toBeGreaterThanOrEqual(4.5);
  });

  test("muted text clears AA on the page", () => {
    expect(contrast(c.textMuted, c.bg)).toBeGreaterThanOrEqual(4.5);
  });

  test("muted text clears AA on a surface, not just on the page", () => {
    // Cards paint --surface, so the muted grey has to survive the lighter ground too.
    expect(contrast(c.textMuted, c.surface)).toBeGreaterThanOrEqual(4.5);
  });

  test("the accent clears AA as text on the page", () => {
    // Not optional: `text-brand` resolves to --accent and is a real text colour here.
    expect(contrast(c.accent, c.bg)).toBeGreaterThanOrEqual(4.5);
  });

  test("accent text clears AA printed on the accent", () => {
    // The pairing that decides whether a primary button is readable.
    expect(contrast(c.accentFg, c.accent)).toBeGreaterThanOrEqual(4.5);
  });

  test("success clears AA, because it is drawn as text", () => {
    expect(contrast(c.success, c.bg)).toBeGreaterThanOrEqual(4.5);
  });

  test("the hairline is visible against the page", () => {
    // Not a WCAG threshold: a border at 1.0 would be invisible and the wireframe
    // grid is load-bearing structure in this design, not decoration.
    expect(contrast(c.border.replace(/[\d.]+\)$/, "1)"), c.bg)).toBeGreaterThan(2);
  });

  test("surface is distinguishable from the page", () => {
    expect(Math.abs(luminance(c.surface) - luminance(c.bg))).toBeGreaterThan(0.002);
  });

  test("nothing is rounded", () => {
    expect(theme.radius).toBe(0);
    expect(theme.button_style).toBe("sharp");
  });
});

describe("presetIdFor", () => {
  test("recognises each preset from its own document", () => {
    for (const p of THEME_PRESETS) expect(presetIdFor(p.theme)).toBe(p.id);
  });

  test("recognises a preset applied through presetPatch", () => {
    expect(presetIdFor(presetPatch("supersanity"))).toBe("supersanity");
  });

  test("a single changed colour reads as custom, not as the preset", () => {
    const edited = presetPatch("supersanity");
    edited.colors.accent = "#00FF00";
    expect(presetIdFor(edited)).toBeNull();
  });

  test("a changed font reads as custom", () => {
    const edited = presetPatch("dark");
    edited.fonts.body = "Comic Sans MS";
    expect(presetIdFor(edited)).toBeNull();
  });

  test("flipping mode alone does not leave you on the preset", () => {
    // setMode keeps the accent and swaps neutrals, which is neither preset.
    expect(presetIdFor({ ...presetPatch("dark"), mode: "light" })).toBeNull();
  });

  test("an absent or empty theme is custom rather than a crash", () => {
    expect(presetIdFor(null)).toBeNull();
    expect(presetIdFor({})).toBeNull();
  });
});

describe("presetPatch", () => {
  test("returns null for an unknown id rather than a half-applied theme", () => {
    expect(presetPatch("berghain")).toBeNull();
  });

  test("hands back copies, so applying a preset cannot mutate it", () => {
    const patch = presetPatch("supersanity");
    patch.colors.bg = "#123456";
    expect(presetPatch("supersanity").colors.bg).toBe("#0D0C0A");
  });

  test("carries every field the editor writes", () => {
    const patch = presetPatch("supersanity");
    expect(Object.keys(patch).sort()).toEqual(
      ["button_style", "colors", "fonts", "mode", "radius", "spacing"]);
  });
});
