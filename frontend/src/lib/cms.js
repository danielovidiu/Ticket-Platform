/**
 * Applies the CMS theme to the whole page by writing CSS custom properties
 * onto :root. Called once when the theme is loaded and again whenever it
 * changes in the editor for a live preview.
 */
import { isCustomFamily } from "./fonts";

/** Families that must never be fetched from Google, for either of two reasons.
 *
 * Clash Display it does not serve at all: asking gets a 404, or in a combined request a
 * 400 that takes every other family down with it. It comes from Fontshare via the
 * @import at the top of index.css.
 *
 * Manrope and IBM Plex Mono it does serve — but index.css now self-hosts them from
 * @fontsource, so a fetch here would pull a second copy of a face the page already has,
 * from a third party, on the default theme. They are listed for the opposite reason to
 * Clash Display and the set means "needs no fetch", not "not on Google". */
const NON_GOOGLE = new Set(["Clash Display", "Manrope", "IBM Plex Mono"]);

/**
 * The half of a palette that has to change when the page flips, per mode.
 *
 * Switching mode in the CMS rewrites exactly these and leaves `accent` and `accentFg`
 * alone, so that a customer who has set their own brand colour still has it after a
 * flip. That is a deliberate trade, NOT a safety property — and this comment used to
 * claim otherwise, on the grounds that the accent "is always used as a fill with
 * accentFg printed on it". It is not: `text-brand` resolves to --accent and is used as
 * a text colour in around forty places, including order and ticket statuses and upload
 * errors. An accent tuned for a dark page can therefore land below AA on a light one —
 * the stock #FF3333 reads 12.8:1 on #050505 and 3.64:1 on #FFFFFF.
 *
 * Two things cover that rather than clobbering the customer's colour here: the Light
 * preset in themePresets.js ships a red that passes on white, and the theme editor
 * warns live on any pairing under AA (see lib/contrast.js).
 *
 * `success` is here rather than with the brand colours because it is drawn AS text. The
 * default acid yellow measures 1.13:1 on white — invisible — so a light theme needs its
 * own, and the flip is the only moment anyone would think to pick one.
 */
export const MODE_NEUTRALS = {
  dark: {
    bg: "#050505",
    surface: "#0F0F0F",
    text: "#FFFFFF",
    textMuted: "#A1A1AA",
    border: "rgba(255,255,255,0.1)",
    success: "#E1FF00",
  },
  light: {
    bg: "#FFFFFF",
    surface: "#F5F5F5",
    text: "#09090B",
    textMuted: "#52525B",
    // Slightly heavier than the dark hairline: a 10% line on white reads fainter than
    // a 10% line on black, so matching the numbers would not match the appearance.
    border: "rgba(9,9,11,0.12)",
    // The same acid, taken down until it reads on white — 5.7:1 instead of 1.13:1.
    success: "#5C6E00",
  },
};

/**
 * "#FF3333" | "#f33" | "rgb(255, 51, 51)" -> "255 51 51", or null if unparseable.
 *
 * Tailwind can only apply an opacity modifier (border-ink/15) to a colour whose channels
 * it can see, which is what the --*-rgb mirrors in index.css hold. This keeps them in
 * step with the hex values a human actually edits.
 */
export function toChannels(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split("").map((ch) => ch + ch).join("") : hex[1];
    return `${parseInt(h.slice(0, 2), 16)} ${parseInt(h.slice(2, 4), 16)} ${parseInt(h.slice(4, 6), 16)}`;
  }
  const rgb = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (rgb) return `${Math.round(+rgb[1])} ${Math.round(+rgb[2])} ${Math.round(+rgb[3])}`;
  return null;
}

export function applyTheme(theme) {
  if (!theme) return;
  const root = document.documentElement;
  const c = theme.colors || {};
  const f = theme.fonts || {};
  const s = theme.spacing || {};
  // Load any custom Google font families before applying them
  if (f.display) ensureFontLoaded(f.display);
  if (f.body) ensureFontLoaded(f.body);
  if (f.mono) ensureFontLoaded(f.mono);

  /** Set the colour and, where Tailwind needs them, its bare channels alongside. */
  const setColor = (name, value, channelName) => {
    if (!value) return;
    root.style.setProperty(name, value);
    if (!channelName) return;
    const ch = toChannels(value);
    if (ch) root.style.setProperty(channelName, ch);
  };

  setColor("--bg", c.bg, "--bg-rgb");
  setColor("--surface", c.surface);
  setColor("--text", c.text, "--text-rgb");
  // --text-muted, not --text-2: the ramp in index.css derives -2, -4 and -5 from this
  // one plus --text. Writing --text-2 directly (as this used to) planted an inline
  // style on top of the derivation and flattened the whole ramp onto one grey.
  setColor("--text-muted", c.textMuted);
  setColor("--accent", c.accent, "--accent-rgb");
  setColor("--accent-fg", c.accentFg);
  setColor("--success", c.success);
  setColor("--border", c.border);

  // Light or dark. Nothing about the colours above depends on this — mode swaps their
  // values rather than being a second axis — but a handful of effects that are not
  // colours still need to know which way round the page runs (see .grain-overlay).
  root.dataset.theme = theme.mode === "light" ? "light" : "dark";

  // Buttons can be fully round while cards and inputs stay square, so this is its own
  // variable rather than a second reading of --radius.
  root.style.setProperty("--btn-radius", theme.button_style === "pill" ? "999px" : "var(--radius)");
  // These three variables are the only place the app's typography is decided — index.css
  // and tailwind.config.js both resolve every font-family through them. Setting the
  // variable is therefore the whole job; nothing needs a matching inline style.
  if (f.display) root.style.setProperty("--font-display", `"${f.display}"`);
  if (f.body) root.style.setProperty("--font-body", `"${f.body}"`);
  if (f.mono) root.style.setProperty("--font-mono", `"${f.mono}"`);
  if (s.sectionY) root.style.setProperty("--section-y", s.sectionY);
  if (s.containerX) root.style.setProperty("--container-x", s.containerX);
  if (theme.radius !== undefined) root.style.setProperty("--radius", `${theme.radius}px`);
  // Nothing is written directly onto <body> here. Background, colour and font-family
  // used to be restated as inline styles on top of the variables above, which the rules
  // in index.css already apply — and an inline style is the one form no later stylesheet
  // (a starter kit's overrides, a print sheet) can win against without !important.
}

/** Default block props factory keyed by block type. */
export const BLOCK_DEFAULTS = {
  // `text_case: "as-typed"` and an explicit `heading_size` are deliberate on NEW blocks:
  // absent means "legacy", and the renderer keeps the old behaviour for blocks that
  // predate these fields so no published page changes appearance. See Hero in
  // components/blocks.
  hero: () => ({
    eyebrow: "Section",
    heading: "New hero",
    body: "Short paragraph describing the section.",
    image_url: "",
    full_frame: true,
    overlay: "solid",
    overlay_color: "#050505",
    overlay_opacity: 45,
    heading_size_desktop: 72,
    heading_size_mobile: 48,
    text_case: "as-typed",
    cta_label: "Buy tickets",
    cta_href: "/events",
    cta_style: "accent",
    second_cta_label: "",
    second_cta_href: "",
    align: "left",
    height: "tall",
  }),
  rich_text: () => ({ content: "## New heading\n\nParagraph text with **bold** words and [links](#)." }),
  image: () => ({ image_url: "", caption: "", full_width: false, aspect: "natural" }),
  gallery_grid: () => ({ heading: "Gallery", limit: 6 }),
  events_grid: () => ({ heading: "Events", eyebrow: "Programme", limit: 4, layout: "grid-2", card_aspect: "16:10" }),
  artists_grid: () => ({ heading: "Artists", eyebrow: "Roster", limit: 6, layout: "grid-3", card_aspect: "1:1" }),
  marquee: () => ({ items: ["ITEM ONE", "ITEM TWO", "ITEM THREE"] }),
  cta_banner: () => ({
    eyebrow: "CTA", image_url: "", heading: "Big statement here.", body: "Supporting line.",
    cta_label: "Do it", cta_href: "#", cta_style: "outline", text_case: "as-typed",
  }),
  contact_form: () => ({ heading: "Say hello", success_message: "Sent." }),
  newsletter: () => ({ heading: "Subscribe", body: "Occasional emails.", cta_label: "Subscribe" }),
  video: () => ({ url: "", file_url: "", poster_url: "", caption: "", autoplay: false, loop: false, muted: true, controls: true, aspect: "16:9" }),
  image_band: () => ({
    eyebrow: "", heading: "Statement over an image.", body: "", image_url: "",
    overlay_color: "#050505", overlay_opacity: 50, height: "medium", align: "left",
    text_case: "as-typed", full_width: true, cta_label: "", cta_href: "", cta_style: "outline",
  }),
  custom_html: () => ({ html: "<div class=\"p-8 text-center font-mono-x uppercase\">Custom HTML</div>" }),
  spacer: () => ({ height: "4rem" }),
  split: () => ({ direction: "image-left", image_url: "", eyebrow: "", heading: "", body: "", cta_label: "", cta_href: "", aspect: "1:1" }),
};

export const BLOCK_LABELS = {
  hero: "Hero",
  rich_text: "Rich text",
  image: "Image",
  gallery_grid: "Gallery grid",
  events_grid: "Events grid",
  artists_grid: "Artists grid",
  marquee: "Marquee",
  cta_banner: "CTA banner",
  contact_form: "Contact form",
  newsletter: "Newsletter",
  video: "Video / audio embed",
  image_band: "Image band",
  custom_html: "Custom HTML",
  spacer: "Spacer",
  split: "Split (image + text)",
};

export const BLOCK_TYPES = Object.keys(BLOCK_LABELS);

export const newBlockId = () => `bk_new_${Math.random().toString(36).slice(2, 10)}`;

/**
 * Dynamically loads a Google Fonts family into the document if not already
 * loaded. Safe to call repeatedly; each family is injected at most once.
 * Family names can be spaces or Title Case, e.g. "Space Grotesk".
 */
const _loadedFonts = new Set();
export function ensureFontLoaded(family) {
  if (!family || typeof family !== "string") return;
  const trimmed = family.trim();
  if (!trimmed || _loadedFonts.has(trimmed)) return;
  // Already available without a fetch: an uploaded face has its own @font-face rule (see
  // lib/fonts.js), and the non-Google defaults are loaded by index.css.
  if (isCustomFamily(trimmed) || NON_GOOGLE.has(trimmed)) { _loadedFonts.add(trimmed); return; }
  const id = `gf-${trimmed.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}`;
  if (document.getElementById(id)) { _loadedFonts.add(trimmed); return; }
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(trimmed).replace(/%20/g, "+")}:wght@300;400;500;600;700;800;900&display=swap`;
  document.head.appendChild(link);
  _loadedFonts.add(trimmed);
}

/**
 * Loads a family at one weight, for drawing its own name in the CMS font picker.
 *
 * Separate from ensureFontLoaded because that pulls seven weights, which is right for a
 * font the site is about to render and wasteful for twenty faces drawn once each in a
 * dropdown. Deliberately one <link> per family rather than one combined request: the
 * Google CSS2 API fails a whole combined request if any single family in it is unknown,
 * which would leave every preview unstyled because of one bad name.
 */
const _previewFonts = new Set();
export function ensureFontPreview(family) {
  const trimmed = (family || "").trim();
  if (!trimmed || _previewFonts.has(trimmed)) return;
  _previewFonts.add(trimmed);
  if (isCustomFamily(trimmed) || NON_GOOGLE.has(trimmed) || _loadedFonts.has(trimmed)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(trimmed).replace(/%20/g, "+")}:wght@400&display=swap`;
  document.head.appendChild(link);
}
