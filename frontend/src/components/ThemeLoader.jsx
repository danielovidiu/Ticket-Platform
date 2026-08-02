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
      try {
        const { data } = await http.get("/cms/fonts");
        if (alive) applyCustomFonts(data);
      } catch {
        // No uploads, or a backend older than this bundle. Google families still work.
      }
      try {
        const { data } = await http.get("/cms/theme");
        if (alive) applyTheme(data?.published);
      } catch {
        // Leaves the defaults in index.css in place.
      }
    })();
    return () => { alive = false; };
  }, []);
  return null;
}
