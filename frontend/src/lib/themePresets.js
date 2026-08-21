/**
 * Complete theme documents the CMS editor can apply in one click.
 *
 * A preset is not a new axis in the theme model — it is just a saved value for the
 * document that already exists, so applying one is an ordinary edit that autosaves,
 * versions and publishes like any other. Nothing here needs a backend change: the
 * server's `_theme_css` reads the same eight colours, three fonts and two spacing
 * values that `applyTheme` does.
 *
 * `mode` stays a separate control. It is the light/dark polarity switch — it rewrites
 * the five neutrals and flips `data-theme` for the handful of effects that are not
 * colours — whereas a preset decides the whole palette including which mode it is in.
 * Picking "Supersanity" therefore sets mode to dark as part of the preset; flipping
 * mode afterwards keeps the accent and lands you on "Custom".
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
    note: "The stock palette. Acid red on near-black.",
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
    note: "The stock palette flipped. Darker red so it still reads on white.",
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
    note: "Warm vault black, concrete surfaces, poster pink. One grotesque throughout.",
    theme: {
      ...STRUCTURE,
      mode: "dark",
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

/** The patch that applies a preset. Colours, fonts and spacing are replaced whole
 *  rather than merged: a preset half-overlaid on the previous palette is exactly the
 *  incoherent state the presets exist to avoid. */
export function presetPatch(id) {
  const preset = THEME_PRESETS.find((p) => p.id === id);
  if (!preset) return null;
  const { colors, fonts, spacing, ...rest } = preset.theme;
  return { ...rest, colors: { ...colors }, fonts: { ...fonts }, spacing: { ...spacing } };
}
