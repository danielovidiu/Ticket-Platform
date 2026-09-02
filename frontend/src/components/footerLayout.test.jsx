/**
 * The footer's shape, after the rework.
 *
 * It was four headed columns — LEGAL over a stack of links, CONTACT over an address —
 * which is a sitemap's shape, not a footer's, and stood 445px tall at 375px. It is now
 * two rows and a rule: who the site is and the pages a reader is owed, then the year and
 * wherever else the site lives.
 *
 * These replace a set that asserted a CSS grid with an auto-fit floor. That floor existed
 * because a column could end up narrower than the unbreakable wordmark; there are no
 * columns now, so the rule it protected went with them. Rewritten rather than deleted
 * because the behaviour underneath — social links only when filled, official marks, no
 * headings — is what actually needs holding.
 *
 * Rendered rather than grepped. The previous file read Layout.jsx as text because jsdom
 * cannot measure a wordmark; what is asserted here is structure, which it can.
 */
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi, describe, test, expect, beforeEach } from "vitest";
import Layout from "./Layout";

const SITE = {
  wordmark: "Supersanity",
  description: "Interdisciplinary platform.",
  contact_heading: "Contact",
  contact_email: "hello@supersanity.live",
  copyright_name: "Supersanity",
  legal_heading: "Legal",
  social: {},
  pages: [
    { slug: "privacy", label: "Privacy" },
    { slug: "terms", label: "Terms" },
    { slug: "cookie-policy", label: "Cookies" },
  ],
};

const site = vi.hoisted(() => ({ current: null }));

vi.mock("../api", () => ({
  http: {
    get: vi.fn((url) => Promise.resolve({
      data: String(url).includes("nav") ? [] : (site.current ?? {}),
    })),
  },
  API: "",
}));
vi.mock("../auth", () => ({ useAuth: () => ({ user: null, logout: vi.fn(), loading: false }), startLogin: vi.fn() }));
vi.mock("./CookieConsent", () => ({ default: () => null }));

async function draw(over = {}) {
  site.current = { ...SITE, ...over };
  const { container } = render(<MemoryRouter><Layout><div /></Layout></MemoryRouter>);
  // The footer paints from a fetch, so wait for something it can only have afterwards.
  // The YEAR, not the wordmark: the wordmark is one of the fields these tests empty, and
  // waiting on it made the emptied-to-the-bone case hang until it timed out.
  await screen.findByText(/©/);
  return container.querySelector("footer");
}

beforeEach(() => { site.current = null; });

describe("footer shape", () => {
  test("it is two rows divided by a rule", async () => {
    const footer = await draw();
    const rule = footer.querySelector(".border-t");
    expect(rule, "no divider between the two rows").toBeTruthy();
    expect(within(rule).getByText(/©/), "the year belongs under the rule").toBeTruthy();
  });

  test("the legal links are one row, not a headed column", async () => {
    const footer = await draw();
    const nav = within(footer).getByTestId("footer-legal");
    for (const label of ["Privacy", "Terms", "Cookies"]) {
      expect(within(nav).getByText(label)).toBeTruthy();
    }
    // The heading is what the rework removed: "LEGAL" over links called Privacy, Terms
    // and Cookies says nothing the links do not, and cost a line plus its margin.
    expect(within(nav).queryByText(/^legal$/i)).toBeNull();
  });

  test("the contact address survives its heading", async () => {
    // Its column heading is gone, so the field that fed it would have become a control
    // with no effect — the exact bug the site settings fix was about. It is the link's
    // title now.
    const footer = await draw();
    const link = within(footer).getByText("hello@supersanity.live");
    expect(link.getAttribute("href")).toBe("mailto:hello@supersanity.live");
    expect(link.getAttribute("title")).toBe("Contact");
  });
});

describe("social links", () => {
  test("nothing renders when none are filled", async () => {
    const footer = await draw({ social: {} });
    expect(within(footer).queryByTestId("footer-social")).toBeNull();
  });

  test("only the ones filled in the CMS render", async () => {
    const footer = await draw({ social: { soundcloud: "https://sc.test/x", spotify: "" } });
    expect(within(footer).getByTestId("footer-social-soundcloud")).toBeTruthy();
    expect(within(footer).queryByTestId("footer-social-spotify")).toBeNull();
  });

  test("a brand gets its mark, and the mark is a real path", async () => {
    const footer = await draw({ social: { soundcloud: "https://sc.test/x" } });
    const path = within(footer).getByTestId("footer-social-soundcloud").querySelector("svg path");
    expect(path, "SoundCloud rendered without an icon").toBeTruthy();
    // Guards against an empty or truncated `d`, which draws nothing and reads as a
    // missing icon rather than a broken one.
    expect(path.getAttribute("d").length).toBeGreaterThan(50);
  });

  test("the icon is labelled for anyone not looking at it", async () => {
    const footer = await draw({ social: { soundcloud: "https://sc.test/x" } });
    const link = within(footer).getByTestId("footer-social-soundcloud");
    expect(link.getAttribute("aria-label")).toBe("SoundCloud");
    // Not both: an accessible name on the anchor plus a title inside the svg reads the
    // platform out twice.
    expect(link.querySelector("svg").getAttribute("aria-hidden")).toBe("true");
  });

  test("a website link falls back to its label, having no brand", async () => {
    // `website` is not a brand — it is whatever domain the site happens to own — so it
    // is the one entry with no mark, on purpose.
    const footer = await draw({ social: { website: "https://example.test" } });
    const link = within(footer).getByTestId("footer-social-website");
    expect(link.querySelector("svg")).toBeNull();
    expect(link.textContent.trim()).toBe("Website");
  });

  test("twitter shows the X mark while keeping its stored key", async () => {
    // Renaming the key would orphan every link already saved under `twitter`.
    const footer = await draw({ social: { twitter: "https://x.test/x" } });
    expect(within(footer).getByTestId("footer-social-twitter").querySelector("svg path")).toBeTruthy();
  });
});

describe("it adapts as fields are emptied", () => {
  /* Every one of these is reachable from Site settings now that blank means blank, so
     each is a state a real footer can be in rather than a hypothetical. */

  test("no wordmark or description leaves the links alone on the top row", async () => {
    const footer = await draw({ wordmark: "", description: "" });
    expect(within(footer).getByTestId("footer-legal")).toBeTruthy();
    // Not an empty box holding the space where the wordmark used to be.
    expect(footer.querySelector(".min-w-0")).toBeNull();
    expect(footer.querySelector(".border-t"), "the rule still divides two rows").toBeTruthy();
  });

  test("with the whole top row empty, the rule is not drawn", async () => {
    // Otherwise it is a line across the top of the page's last element, dividing the
    // copyright from nothing.
    const footer = await draw({ wordmark: "", description: "", contact_email: "", pages: [] });
    expect(footer.querySelector(".border-t")).toBeNull();
    expect(within(footer).getByText(/©/), "the year survives on its own").toBeTruthy();
  });

  test("emptied to the bone, it is still a footer and not a broken one", async () => {
    const footer = await draw({
      wordmark: "", description: "", contact_email: "", copyright_name: "", pages: [], social: {},
    });
    expect(footer).toBeTruthy();
    expect(footer.querySelector(".border-t")).toBeNull();
    expect(within(footer).queryByTestId("footer-social")).toBeNull();
    // The year is computed, never authored, so it is the one thing that cannot be emptied.
    expect(footer.textContent).toMatch(/© \d{4}/);
  });

  test("social alone still gets a rule above it when there is a top row", async () => {
    const footer = await draw({ description: "", social: { soundcloud: "https://sc.test/x" } });
    expect(footer.querySelector(".border-t")).toBeTruthy();
    expect(within(footer).getByTestId("footer-social-soundcloud")).toBeTruthy();
  });
});
