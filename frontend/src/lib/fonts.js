/**
 * Webfonts uploaded through the CMS.
 *
 * A Google family arrives as a stylesheet <link> that ensureFontLoaded() in cms.js adds.
 * An uploaded face has no such stylesheet, so this module writes one: a single <style>
 * element holding one @font-face per uploaded file. It has to be in the document before
 * applyTheme() sets --font-display and friends, or the variables briefly name a family
 * the browser has never heard of and the page flashes its fallback.
 */
import { mediaUrl } from "./media";

const STYLE_ID = "cms-custom-fonts";

/** What the `format()` hint is called in CSS, which is not what the file extension is
 * called. An unrecognised value would make the browser skip the source outright, so an
 * unknown format omits the hint instead of guessing — it is an optimisation, not a
 * requirement. */
const CSS_FORMAT = { woff2: "woff2", woff: "woff", ttf: "truetype", otf: "opentype" };

let registered = new Set();

/** True for a family that came from an upload rather than from Google.
 *
 * ensureFontLoaded() consults this before reaching for Google Fonts: a brand face is by
 * definition not in that catalogue, so the request would 404 on every page load, and if
 * the name did happen to collide with a Google family the site would silently render in
 * somebody else's typeface. */
export function isCustomFamily(family) {
  return registered.has((family || "").trim());
}

/** Escapes a value going into a CSS string literal. The family name is already
 * constrained by FAMILY_RE server-side and the URL is server-generated, so this is the
 * second of two locks rather than the only one. */
const cssStr = (v) => String(v == null ? "" : v).replace(/[\\"]/g, "\\$&");

/** Pure: the @font-face block for a list of faces. Separated from the DOM write so it
 * can be asserted on directly. */
export function fontFaceCss(fonts) {
  return (fonts || [])
    .filter((f) => f && f.family && f.url)
    .map((f) => {
      const hint = CSS_FORMAT[f.format];
      const src = `url("${cssStr(mediaUrl(f.url))}")` + (hint ? ` format("${cssStr(hint)}")` : "");
      return [
        "@font-face {",
        `  font-family: "${cssStr(f.family)}";`,
        `  src: ${src};`,
        `  font-weight: ${Number(f.weight) || 400};`,
        `  font-style: ${f.style === "italic" ? "italic" : "normal"};`,
        // Show the fallback while the file downloads rather than nothing at all. A brand
        // face is not worth a blank page on a slow connection.
        "  font-display: swap;",
        "}",
      ].join("\n");
    })
    .join("\n\n");
}

/** Install the uploaded faces and record their families. Idempotent — reuses the same
 * <style> element, so the CMS can call it again after an upload without stacking rules. */
export function applyCustomFonts(fonts) {
  registered = new Set((fonts || []).map((f) => (f.family || "").trim()).filter(Boolean));
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = fontFaceCss(fonts);
  return registered;
}
