/**
 * Applies the CMS theme to the whole page by writing CSS custom properties
 * onto :root. Called once when the theme is loaded and again whenever it
 * changes in the editor for a live preview.
 */
export function applyTheme(theme) {
  if (!theme) return;
  const root = document.documentElement;
  const c = theme.colors || {};
  const f = theme.fonts || {};
  const s = theme.spacing || {};
  if (c.bg) root.style.setProperty("--bg", c.bg);
  if (c.surface) root.style.setProperty("--surface", c.surface);
  if (c.text) root.style.setProperty("--text", c.text);
  if (c.textMuted) root.style.setProperty("--text-2", c.textMuted);
  if (c.accent) root.style.setProperty("--accent", c.accent);
  if (c.accentFg) root.style.setProperty("--accent-fg", c.accentFg);
  if (c.success) root.style.setProperty("--success", c.success);
  if (c.border) root.style.setProperty("--border", c.border);
  if (f.display) root.style.setProperty("--font-display", `"${f.display}"`);
  if (f.body) root.style.setProperty("--font-body", `"${f.body}"`);
  if (f.mono) root.style.setProperty("--font-mono", `"${f.mono}"`);
  if (s.sectionY) root.style.setProperty("--section-y", s.sectionY);
  if (s.containerX) root.style.setProperty("--container-x", s.containerX);
  if (theme.radius !== undefined) root.style.setProperty("--radius", `${theme.radius}px`);
  document.body.style.background = c.bg || "#050505";
  document.body.style.color = c.text || "#FFFFFF";
  if (f.body) document.body.style.fontFamily = `"${f.body}", system-ui, sans-serif`;
}

/** Default block props factory keyed by block type. */
export const BLOCK_DEFAULTS = {
  hero: () => ({
    eyebrow: "SECTION",
    heading: "New Hero",
    body: "Short paragraph describing the section.",
    image_url: "",
    cta_label: "Buy Tickets",
    cta_href: "/events",
    cta_style: "accent",
    second_cta_label: "",
    second_cta_href: "",
    align: "left",
    height: "tall",
  }),
  rich_text: () => ({ content: "## New heading\n\nParagraph text with **bold** words and [links](#)." }),
  image: () => ({ image_url: "", caption: "", full_width: false }),
  gallery_grid: () => ({ heading: "Gallery", limit: 6 }),
  events_grid: () => ({ heading: "Events", eyebrow: "Programme", limit: 4, layout: "grid-2" }),
  artists_grid: () => ({ heading: "Artists", eyebrow: "Roster", limit: 6, layout: "grid-3" }),
  marquee: () => ({ items: ["ITEM ONE", "ITEM TWO", "ITEM THREE"] }),
  cta_banner: () => ({ heading: "Big statement here.", body: "Supporting line.", cta_label: "Do it", cta_href: "#" }),
  contact_form: () => ({ heading: "Say hello", success_message: "Sent." }),
  newsletter: () => ({ heading: "Subscribe", body: "Occasional emails.", cta_label: "Subscribe" }),
  video: () => ({ url: "", caption: "" }),
  custom_html: () => ({ html: "<div class=\"p-8 text-center font-mono-x uppercase\">Custom HTML</div>" }),
  spacer: () => ({ height: "4rem" }),
  split: () => ({ direction: "image-left", image_url: "", eyebrow: "", heading: "", body: "", cta_label: "", cta_href: "" }),
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
  video: "Video embed",
  custom_html: "Custom HTML",
  spacer: "Spacer",
  split: "Split (image + text)",
};

export const BLOCK_TYPES = Object.keys(BLOCK_LABELS);

export const newBlockId = () => `bk_new_${Math.random().toString(36).slice(2, 10)}`;
