/**
 * WCAG contrast maths, shared by the theme editor's warnings and the preset tests.
 *
 * It lives here rather than inside either caller because the two must agree: a preset
 * that passes its test and then trips a warning in the editor would be telling the
 * person two different things about the same palette.
 */

/** sRGB channel -> linear, per WCAG 2.1. */
function channel(v) {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/**
 * Relative luminance of a CSS colour, or null if it is not one this can read.
 *
 * Handles the three forms the theme document actually stores: #rgb, #rrggbb and
 * rgb()/rgba(). Alpha is ignored rather than composited — every caller here asks about
 * a colour against a known ground, and the one translucent token (--border) is checked
 * at full strength on purpose.
 */
export function luminance(color) {
  if (typeof color !== "string") return null;
  const v = color.trim();
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }
  const rgb = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (rgb) {
    const [r, g, b] = [+rgb[1], +rgb[2], +rgb[3]];
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }
  return null;
}

/** Contrast ratio between two colours, 1–21, or null if either is unreadable. */
export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA for normal-size text. */
export const AA_TEXT = 4.5;

/**
 * The pairings in this app whose contrast actually decides whether something is
 * readable, as {label, fg, bg} keys into a theme's colours.
 *
 * `accent` is in here as a FOREGROUND, which is the part the codebase got wrong for a
 * long time: `text-brand` is a text colour in around forty places — order and ticket
 * statuses, upload errors — so an accent is not just a fill and its contrast against
 * the page is not cosmetic.
 */
export const CONTRAST_PAIRS = [
  { label: "Text on background", fg: "text", bg: "bg" },
  { label: "Muted text on background", fg: "textMuted", bg: "bg" },
  { label: "Muted text on surface", fg: "textMuted", bg: "surface" },
  { label: "Accent as text", fg: "accent", bg: "bg" },
  { label: "Accent text on accent", fg: "accentFg", bg: "accent" },
  { label: "Success as text", fg: "success", bg: "bg" },
];

/**
 * Every pairing in a palette that falls below AA, as
 * [{label, ratio, fg, bg}], most severe first. Empty means the palette passes.
 */
export function failingPairs(colors) {
  if (!colors) return [];
  return CONTRAST_PAIRS
    .map((p) => ({ ...p, ratio: contrastRatio(colors[p.fg], colors[p.bg]) }))
    .filter((p) => p.ratio !== null && p.ratio < AA_TEXT)
    .sort((a, b) => a.ratio - b.ratio);
}
