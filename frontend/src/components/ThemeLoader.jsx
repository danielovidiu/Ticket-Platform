import { useEffect } from "react";
import { http } from "../api";
import { applyTheme } from "../lib/cms";
import { applyCustomFonts } from "../lib/fonts";

/**
 * Fetches the published theme once at app mount and injects it as CSS custom properties
 * on :root. Fails silently — if the CMS isn't seeded yet the app falls back to the
 * default CSS variables in index.css.
 *
 * Uploaded fonts are installed first and awaited. applyTheme() calls ensureFontLoaded(),
 * which has to be able to tell an uploaded family from a Google one before it decides
 * whether to fetch it, and the @font-face rules have to exist before --font-display
 * names them.
 */
export default function ThemeLoader() {
  useEffect(() => {
    let alive = true;
    (async () => {
      // FETCHED TOGETHER, APPLIED IN ORDER.
      //
      // These used to be two awaits in a row, so the theme request did not start until
      // the fonts request had finished — one round trip stacked on another for no reason
      // but the order the two lines happened to be written in.
      //
      // The ordering that actually matters is in the APPLYING, not the fetching:
      // applyTheme calls ensureFontLoaded, which has to know which families are uploads
      // before it decides whether to go looking for one on Google, and the @font-face
      // rules have to exist before --font-display names them. Settling both requests
      // first and then applying them in sequence keeps that guarantee and costs one
      // round trip instead of two.
      const [fonts, theme] = await Promise.allSettled([
        http.get("/cms/fonts"),
        http.get("/cms/theme"),
      ]);
      if (!alive) return;

      // No uploads, or a backend older than this bundle. Google families still work.
      if (fonts.status === "fulfilled") applyCustomFonts(fonts.value.data);
      // Leaves whatever /cms/theme.css already put on :root in place.
      if (theme.status === "fulfilled") applyTheme(theme.value.data?.published);
    })();
    return () => { alive = false; };
  }, []);
  return null;
}
