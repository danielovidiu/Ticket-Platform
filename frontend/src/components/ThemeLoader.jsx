import { useEffect } from "react";
import { http } from "../api";
import { applyTheme } from "../lib/cms";

/**
 * Fetches the currently-published theme once at app mount and injects it
 * as CSS custom properties on :root. Fails silently — if the CMS isn't
 * seeded yet the app falls back to the default CSS variables in index.css.
 */
export default function ThemeLoader() {
  useEffect(() => {
    http.get("/cms/theme")
      .then((r) => applyTheme(r.data?.published))
      .catch(() => {});
  }, []);
  return null;
}
