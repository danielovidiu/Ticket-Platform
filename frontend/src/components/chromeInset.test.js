/**
 * The site chrome sits on the same edge as the content.
 *
 * The blocks were moved onto a shared `--text-inset` token, and the header, footer,
 * phone menu and cookie banner were not — so they kept their own `px-6 md:px-10` and
 * ended up 8px further in than everything above them. Measured on the live site: hero
 * text at 16, footer and cookie text at 24. Two vertical edges on one page, which is
 * exactly what the token exists to prevent.
 *
 * Asserted against the SOURCE rather than a render. These components need a router, an
 * HTTP mock and loaded site settings before they draw anything, and the rule being
 * protected is "this file does not hard-code a horizontal gutter" — a property of the
 * text, not of a tree. A render test would be more machinery and less direct.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every file that paints something at the edge of the viewport outside a CMS block. */
const CHROME = ["Layout.jsx", "CookieConsent.jsx"];

/**
 * GUTTER-scale horizontal padding written as a literal — px-6 and up, plus responsive
 * variants and arbitrary values.
 *
 * Deliberately not "any px-*". A cart badge is `px-1.5` and a dropdown row is `px-3`:
 * those are internal padding inside a component that is already inset, they have nothing
 * to do with the edge of the screen, and forbidding them would be a rule about spacing in
 * general rather than about the viewport gutter. The cut is at 6 because that — 24px — is
 * the smallest value that was ever used here as an edge gutter.
 */
const GUTTER_X_PADDING = /(?:^|["'\s])(?:[a-z]+:)?px-(?:[6-9]|\d{2,}|\[[^\]]+\])/;

describe("site chrome uses the shared text inset", () => {
  test.each(CHROME)("%s hard-codes no horizontal gutter", (file) => {
    const src = readFileSync(join(HERE, file), "utf8");
    const offenders = src
      .split("\n")
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => GUTTER_X_PADDING.test(line));

    expect(
      offenders.map(([n, line]) => `${file}:${n} ${line.trim().slice(0, 80)}`),
      `${file} sets its own side padding; it should use the edge-inset class so the ` +
      `Site → Text inset control moves it with everything else`
    ).toEqual([]);
  });

  test.each(CHROME)("%s actually applies edge-inset", (file) => {
    // The negative test above passes trivially if a file stops padding altogether, which
    // would put the chrome text against the glass rather than on the shared line.
    const src = readFileSync(join(HERE, file), "utf8");
    expect(src, `${file} has no edge-inset at all`).toMatch(/edge-inset/);
  });
});
