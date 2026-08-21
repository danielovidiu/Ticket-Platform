/**
 * The themes offered by the one dropdown in CMS -> Theme, in the order they appear.
 *
 * There is deliberately no second control. Dark and Light have always lived in that
 * select, and Supersanity sits in the same list, because "which theme is this site"
 * is one question — asking it in two widgets is how an editor ends up with a palette
 * that half-matches two different things.
 *
 * The list holds two kinds of entry, and the difference is what selecting one does:
 *
 *   kind: "mode"  Dark and Light. They rewrite the five neutrals and leave the accent
 *                 and the fonts alone, so a customer who has set their own brand red
 *                 still has it after switching. This is the long-standing behaviour,
 *                 and changing it would quietly repaint every whitelabel deployment.
 *
 *   kind: "full"  Supersanity. A named, designed theme, so selecting it applies the
 *                 whole document — palette, fonts and spacing. Picking a theme by name
 *                 and getting someone else's accent would be the wrong answer.
 *
 * `mode` is what the select binds to and what the server stores, so a named theme puts
 * its own id there. Both readers of that field already cope with a third value:
 * applyTheme treats anything that is not "light" as dark, and the backend's
 * `_theme_css` only ever asks whether it equals "light".
 *
 * Nothing here needs a backend change — `_theme_css` reads the same eight colours,
 * three fonts and two spacing values that `applyTheme` does.
 */
import { MODE_NEUTRALS } from "./cms";

/** Values every preset shares, because all three reference clubs share them: nothing
 *  in this world has a corner radius, and no button is ever a pill. */
const STRUCTURE = { radius: 0, button_style: "sharp" };

/* The "Dark" preset below has to stay byte-identical to `_default_theme()` in
   backend/cms_routes.py. It is not a copy for its own sake — it is what makes a
   freshly seeded site show "Dark" as its active preset instead of "Custom". If the
   seed changes, change this with it. */

/**
 * The house brand pair. It is not one pair but two, because the red has to change
 * when the page does.
 *
 * `text-brand` is a text colour in around forty places (order and ticket statuses,
 * upload errors), so the accent has to clear AA against the page it sits on. #FF3333
 * manages 12.8:1 on near-black and only 3.64:1 on white.
 *
 * Darkening it far enough for white (#DB0000, 5.23:1) then breaks the other half of
 * the pair: black on that red is 4.01:1. There is no red that satisfies both — the
 * window is a luminance band about 0.008 wide — so the light theme prints WHITE on its
 * accent instead. That turns out to be the tidier constraint anyway: "accent readable
 * on white" and "white readable on accent" are the same comparison, so one number
 * governs both.
 *
 * #DB0000 is hsl(0,100%,43%) to #FF3333's hsl(0,100%,60%) — the same hue and
 * saturation, only darker, so it reads as the house red rather than a different one.
 */
const HOUSE_BRAND_DARK = { accent: "#FF3333", accentFg: "#000000" };
const HOUSE_BRAND_LIGHT = { accent: "#DB0000", accentFg: "#FFFFFF" };

const HOUSE_FONTS = { display: "Clash Display", body: "Manrope", mono: "IBM Plex Mono" };

export const THEME_PRESETS = [
  {
    id: "dark",
    label: "Dark",
    kind: "mode",
    note: "Swaps the neutral colours. Keeps your accent and fonts.",
    theme: {
      ...STRUCTURE,
      mode: "dark",
      colors: { ...MODE_NEUTRALS.dark, ...HOUSE_BRAND_DARK },
      fonts: { ...HOUSE_FONTS },
      spacing: { sectionY: "6rem", containerX: "2.5rem" },
    },
  },
  {
    id: "light",
    label: "Light",
    kind: "mode",
    note: "Swaps the neutral colours. Keeps your accent and fonts.",
    theme: {
      ...STRUCTURE,
      mode: "light",
      colors: { ...MODE_NEUTRALS.light, ...HOUSE_BRAND_LIGHT },
      fonts: { ...HOUSE_FONTS },
      spacing: { sectionY: "6rem", containerX: "2.5rem" },
    },
  },
  {
    id: "supersanity",
    label: "Supersanity",
    kind: "full",
    note: "Replaces the whole palette, fonts and spacing.",
    theme: {
      ...STRUCTURE,
      /* Its own id, not "dark". This is what the select binds to, and it is how the
         dropdown still reads "Supersanity" after a reload. Everything downstream
         treats a non-"light" mode as dark, which is what this is. */
      mode: "supersanity",
      colors: {
        /* Neither Tresor's pure #000 nor Berghain's neutral #141414: the reference
           posters' blur fields are warm, so the ground carries a little red and
           the whole palette sits on top of that rather than on a cold grey. */
        bg: "#0D0C0A",
        /* Bassiani's concrete (#E0E0E0) is the most distinctive surface of the three
           sites. Inverted into a dark world it becomes a lifted warm grey, which is
           what stops cards reading as holes cut in the page. */
        surface: "#191713",
        /* Warm off-white, not #FFFFFF. Berghain never prints pure white either. */
        text: "#F2EFE9",
        /* Berghain's #A7A7A7 body grey, warmed to match. 6.5:1 on the ground. */
        textMuted: "#9C958A",
        /* The one saturated colour in the reference set — the hot pink of the second
           poster — pulled up until it clears 5:1 as text on the ground. */
        accent: "#FF1F6C",
        /* Printed ON the accent, so it inverts: white on this pink is only 3.7:1. */
        accentFg: "#0D0C0A",
        /* Kept from the house palette. It is drawn as text for success states and it
           is the one genuinely rave-native colour in the system. */
        success: "#E1FF00",
        /* Bassiani draws its hairlines at FULL ink strength, not as a 10% ghost, and
           that is what turns a page of cards into Berghain's cell grid. 22% is that
           idea taken as far as a dark ground will bear without glare. */
        border: "rgba(242,239,233,0.22)",
      },
      /* All three sites run a single neo-grotesque for everything — Graphik, Px
         Grotesk, one heavy face at Bassiani. Archivo is the Google-served stand-in
         for that class and for the posters' Helvetica Now Display. Display and body
         are deliberately the same family; only the meta/label mono differs. */
      fonts: { display: "Archivo", body: "Archivo", mono: "IBM Plex Mono" },
      /* Tighter gutter than stock, for Bassiani's edge-to-edge slabs; taller sections,
         for the 12% vertical insets the posters hold. */
      spacing: { sectionY: "7rem", containerX: "1.5rem" },
    },
  },
];

/** The fields a preset owns. Anything outside this list is left alone when one is
 *  applied, and ignored when working out which preset is currently active. */
const OWNED_COLORS = ["bg", "surface", "text", "textMuted", "accent", "accentFg", "success", "border"];
const OWNED_FONTS = ["display", "body", "mono"];
const OWNED_SPACING = ["sectionY", "containerX"];

function sameSubset(a, b, keys) {
  return keys.every((k) => (a?.[k] ?? null) === (b?.[k] ?? null));
}

/**
 * Which preset a theme document currently matches, or null for a hand-edited palette.
 * The picker reads "Custom" on null, so that touching any colour stops the UI claiming
 * the theme is still a preset it no longer is.
 */
export function presetIdFor(theme) {
  if (!theme) return null;
  const match = THEME_PRESETS.find((p) =>
    (theme.mode || "dark") === p.theme.mode
    && (theme.radius || 0) === p.theme.radius
    && (theme.button_style || "sharp") === p.theme.button_style
    && sameSubset(theme.colors, p.theme.colors, OWNED_COLORS)
    && sameSubset(theme.fonts, p.theme.fonts, OWNED_FONTS)
    && sameSubset(theme.spacing, p.theme.spacing, OWNED_SPACING));
  return match ? match.id : null;
}

/** The patch that applies a preset in full. Colours, fonts and spacing are replaced
 *  whole rather than merged: a preset half-overlaid on the previous palette is exactly
 *  the incoherent state a named theme exists to avoid. */
export function presetPatch(id) {
  const preset = THEME_PRESETS.find((p) => p.id === id);
  if (!preset) return null;
  const { colors, fonts, spacing, ...rest } = preset.theme;
  return { ...rest, colors: { ...colors }, fonts: { ...fonts }, spacing: { ...spacing } };
}

/**
 * The patch for choosing `id` in the theme dropdown, given the palette already there.
 *
 * This is where the two kinds diverge, and it lives here rather than in the component
 * so the branch is testable: a "mode" entry swaps neutrals over whatever the customer
 * has, a "full" entry replaces the document. Returns null for an id that is not on the
 * list, so a stale value cannot half-apply.
 */
export function themeChoicePatch(id, currentColors) {
  const preset = THEME_PRESETS.find((p) => p.id === id);
  if (!preset) return null;
  if (preset.kind === "full") return presetPatch(id);
  return {
    mode: preset.theme.mode,
    colors: { ...(currentColors || {}), ...MODE_NEUTRALS[preset.theme.mode] },
  };
}
