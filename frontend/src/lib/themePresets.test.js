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
import { THEME_PRESETS, presetIdFor, presetPatch, themeChoicePatch } from "./themePresets";
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
    // A mode choice keeps the accent and swaps neutrals, which is neither preset.
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

describe("themeChoicePatch", () => {
  /* The dropdown holds two kinds of entry and they behave differently on purpose.
     This is the branch that decides which, so it is the thing worth pinning. */

  test("Dark and Light keep the customer's own accent and fonts", () => {
    // The whole reason mode entries do not replace the document: a whitelabel
    // deployment must not be repainted by someone toggling light and dark.
    const mine = { ...presetPatch("dark").colors, accent: "#00E5FF", accentFg: "#001014" };
    const patch = themeChoicePatch("light", mine);
    expect(patch.colors.accent).toBe("#00E5FF");
    expect(patch.colors.accentFg).toBe("#001014");
    expect(patch.fonts).toBeUndefined();
  });

  test("Dark and Light still swap the neutrals", () => {
    const patch = themeChoicePatch("light", presetPatch("dark").colors);
    expect(patch.colors.bg).toBe("#FFFFFF");
    expect(patch.colors.text).toBe("#09090B");
    expect(patch.mode).toBe("light");
  });

  test("Supersanity replaces the palette, fonts and spacing", () => {
    const mine = { ...presetPatch("dark").colors, accent: "#00E5FF" };
    const patch = themeChoicePatch("supersanity", mine);
    expect(patch.colors.accent).toBe("#FF1F6C");
    expect(patch.colors.bg).toBe("#0D0C0A");
    expect(patch.fonts.display).toBe("Archivo");
    expect(patch.spacing.sectionY).toBe("7rem");
  });

  test("Supersanity stores its own id as the mode, so the dropdown reads it back", () => {
    expect(themeChoicePatch("supersanity", {}).mode).toBe("supersanity");
  });

  test("that mode is treated as dark by everything downstream", () => {
    // applyTheme: `mode === "light" ? "light" : "dark"`. The backend asks the same
    // question. Both must land on dark for a theme that is dark.
    const mode = themeChoicePatch("supersanity", {}).mode;
    expect(mode).not.toBe("light");
  });

  test("an unknown id patches nothing rather than half-applying", () => {
    expect(themeChoicePatch("berghain", {})).toBeNull();
  });

  test("survives an empty starting palette", () => {
    expect(themeChoicePatch("dark", undefined).colors.bg).toBe("#050505");
  });
});

/**
 * The nav size reaching the document.
 *
 * `applyTheme` sets every variable the live preview needs. It did not set `--nav-size`,
 * which is why the Theme pane's "Menu text size" slider read as a dead control: it wrote
 * to the draft, the preview applied everything except that one variable, and the header
 * did not move. Publishing would have fixed it on the next load — but nobody gets that
 * far past a slider that appears to do nothing.
 */
import { applyTheme } from "./cms";

describe("applyTheme and the nav size", () => {
  const navSize = () => document.documentElement.style.getPropertyValue("--nav-size");

  beforeEach(() => document.documentElement.style.removeProperty("--nav-size"));

  test("a theme carrying a size applies it", () => {
    applyTheme({ colors: {}, fonts: {}, nav_size: 18 });
    expect(navSize()).toBe("18px");
  });

  test("it is clamped the same way the stylesheet clamps it", () => {
    applyTheme({ colors: {}, fonts: {}, nav_size: 900 });
    expect(navSize()).toBe("32px");
    applyTheme({ colors: {}, fonts: {}, nav_size: 1 });
    expect(navSize()).toBe("8px");
  });

  test("0 is clamped, not read as absent", () => {
    applyTheme({ colors: {}, fonts: {}, nav_size: 0 });
    expect(navSize()).toBe("8px");
  });

  test("a theme without one leaves the variable alone", () => {
    // The value lives in the site settings now; a theme that does not carry one must not
    // stamp a default over what the stylesheet already set.
    document.documentElement.style.setProperty("--nav-size", "14px");
    applyTheme({ colors: {}, fonts: {} });
    expect(navSize()).toBe("14px");
  });

  test("junk does not reach the DOM as NaNpx", () => {
    applyTheme({ colors: {}, fonts: {}, nav_size: "abc" });
    expect(navSize()).toBe("11px");
  });
});
