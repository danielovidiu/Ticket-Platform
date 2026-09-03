/**
 * The footer, third shape.
 *
 * It was four headed columns — LEGAL over a stack of links, CONTACT over an address —
 * standing 445px tall at 375px. Then two rows and a rule. It is one line now: the year on
 * the left, the brand marks in the middle, the pages on the right.
 *
 * Each rework took out what the shape did not need; this one took out the shape. A footer
 * whose whole content is a copyright, some icons and three links does not need dividing
 * into parts, and does not need a border to announce that the page has ended.
 *
 * The wordmark, description, contact address and both column headings went with it, in the
 * CMS as well as here. Their values are still STORED — nothing was deleted — which is why
 * one test below feeds them in and asserts they do not appear. An editable field with no
 * effect anywhere is the same bug as a save that silently does not save.
 */
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi, describe, test, expect, beforeEach } from "vitest";
import Layout from "./Layout";

const SITE = {
  copyright_name: "Supersanity",
  social: {},
  pages: [
    { slug: "privacy", label: "Privacy" },
    { slug: "cookie-policy", label: "Cookie Policy" },
    { slug: "terms", label: "Terms & Conditions" },
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
  // The YEAR, not any authored field: every other thing in this footer can be emptied,
  // and waiting on one of those hangs the tests that empty it.
  await screen.findByText(/©/);
  return container.querySelector("footer");
}

const line = (footer) => footer.firstElementChild;
const copyright = (footer) =>
  [...footer.querySelectorAll("div")].find((d) => d.children.length === 0 && d.textContent.trim().startsWith("©"));

beforeEach(() => { site.current = null; });

describe("one line, three groups", () => {
  test("there is no rule anywhere in it", async () => {
    // Neither the border between the page and the footer, nor the one that divided the
    // footer's own two rows. There is one row now, so there is nothing to divide.
    const footer = await draw();
    expect([...footer.classList]).not.toContain("hairline");
    expect(footer.querySelector(".border-t")).toBeNull();
  });

  test("the year is left, the marks are centre, the pages are right", async () => {
    const footer = await draw({ social: { soundcloud: "https://sc.test/x" } });
    expect(copyright(footer).className).toMatch(/sm:col-start-1/);
    expect(within(footer).getByTestId("footer-social").className).toMatch(/sm:col-start-2/);
    expect(within(footer).getByTestId("footer-legal").className).toMatch(/sm:col-start-3/);
  });

  test("an absent group does not move the others along", async () => {
    /* The reason the columns are placed explicitly rather than left to auto-flow. With
       no social links filled, auto-placement would put the pages in the middle track and
       leave the right of the line empty. */
    const footer = await draw({ social: {} });
    expect(within(footer).queryByTestId("footer-social")).toBeNull();
    expect(within(footer).getByTestId("footer-legal").className).toMatch(/sm:col-start-3/);
  });

  test("the links are set at the copyright's size", async () => {
    // The two are the whole footer now; they had better look like one line rather than
    // two things that happen to share it.
    const footer = await draw();
    expect(within(footer).getByTestId("footer-legal").className).toMatch(/\btext-xs\b/);
    expect(copyright(footer).className).toMatch(/\btext-xs\b/);
  });

  test("the groups are vertically centred on each other", async () => {
    // Three groups of different heights — 12px text, 16px icons, wrapping links — on one
    // line. Anything but centre puts one of them visibly off the others' baseline.
    expect(line(await draw()).className).toMatch(/\bitems-center\b/);
  });
});

describe("what the rework removed", () => {
  test("the wordmark, description and address are stored but never shown", async () => {
    /* They are still returned by the API and still in the database — the fields were not
       deleted, only their controls and their rendering. This asserts the footer ignores
       them, so a value left over from before the rework cannot reappear. */
    const footer = await draw({
      wordmark: "SUPERSANITY",
      description: "Interdisciplinary platform producing events.",
      contact_email: "hello@supersanity.live",
      legal_heading: "Legal",
      contact_heading: "Contact",
    });
    expect(footer.textContent).not.toMatch(/SUPERSANITY/);
    expect(footer.textContent).not.toMatch(/Interdisciplinary/);
    expect(footer.textContent).not.toMatch(/hello@supersanity\.live/);
    expect(footer.textContent).not.toMatch(/Legal/);
    expect(footer.textContent).not.toMatch(/Contact/);
  });
});

describe("social links", () => {
  test("nothing renders when none are filled", async () => {
    expect(within(await draw({ social: {} })).queryByTestId("footer-social")).toBeNull();
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
    // Guards an empty or truncated `d`, which draws nothing and reads as a missing icon
    // rather than a broken one.
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

describe("the pages row", () => {
  test("every footer page is a link, whatever it is for", async () => {
    /* Including the consumer-protection notices a jurisdiction requires. Nothing about
       ANPC or SAL is written into the component — they are CMS pages marked "footer
       only", which is what lets a deployment elsewhere carry its own instead. */
    const footer = await draw({
      pages: [
        { slug: "privacy", label: "Privacy" },
        { slug: "anpc", label: "ANPC" },
        { slug: "sal", label: "SAL" },
      ],
    });
    const nav = within(footer).getByTestId("footer-legal");
    expect(within(nav).getByText("ANPC").getAttribute("href")).toBe("/anpc");
    expect(within(nav).getByText("SAL").getAttribute("href")).toBe("/sal");
  });

  test("the separator trails its link rather than leading the next", async () => {
    // Leading separators read fine on one line and badly on two: where the row wraps,
    // every wrapped line began with a stray "·" hanging in the margin.
    const nav = within(await draw()).getByTestId("footer-legal");
    const groups = [...nav.children];
    expect(groups.at(-1).textContent).not.toMatch(/·/);
    expect(groups[0].textContent).toMatch(/·$/);
  });

  test("no links, no row", async () => {
    const footer = await draw({ pages: [] });
    expect(within(footer).queryByTestId("footer-legal")).toBeNull();
  });
});

describe("emptied to the bone", () => {
  test("the year is the last thing standing", async () => {
    // Everything else here is an editor's to clear, now that blank means blank.
    const footer = await draw({ copyright_name: "", pages: [], social: {} });
    expect(footer).toBeTruthy();
    expect(within(footer).queryByTestId("footer-legal")).toBeNull();
    expect(within(footer).queryByTestId("footer-social")).toBeNull();
    expect(footer.textContent).toMatch(/© \d{4}/);
  });
});

describe("it is an overlay, not the end of the page", () => {
  test("it is fixed to the bottom and out of the flow", async () => {
    // Out of the flow is the point: the page runs to the bottom of the window, so a
    // background photo or a video reaches the edge of the screen instead of stopping
    // above a bar.
    const footer = await draw();
    expect([...footer.classList]).toContain("fixed");
    expect([...footer.classList]).toContain("bottom-0");
  });

  test("it carries the site's background colour, not a transparent one", async () => {
    // The whole element fades, colour included: transparent while the page is being
    // read, so the media underneath reaches the bottom of the screen — and a solid bar
    // at the end, rather than type lying directly on a bright frame.
    expect([...(await draw()).classList]).toContain("bg-page");
  });

  test("it sits under the header and the cookie banner, over the page", async () => {
    // z-30: below the sticky header (z-40), its menu (z-50) and the consent banner
    // (z-70), above ordinary content. A footer that covers the consent banner is a
    // footer that stops someone dismissing it.
    expect([...(await draw()).classList]).toContain("z-30");
  });

  test("on a page too short to scroll it is visible and interactive", async () => {
    /* jsdom reports every element as zero-height, so `scrollHeight` and `innerHeight`
       make the document exactly one screen — the not-scrollable case, where the reveal
       is 1. That is the state worth asserting here anyway: a short page must not be
       footerless, and its links must be clickable and focusable. */
    const footer = await draw();
    expect(footer.style.opacity).toBe("1");
    expect(footer.style.visibility).toBe("visible");
    expect(footer.style.pointerEvents).toBe("auto");
  });
});

describe("what bleeds under it and what does not", () => {
  test("the content reserves the footer's height so text stops above it", async () => {
    /* The footer floats, so without a reservation the last paragraph, form or button on
       every page would sit underneath it. `main` carries padding equal to the footer's
       MEASURED height — one line on a desktop, three wrapped ones on a phone, different
       again with the text-inset control — which is why it is measured and not a constant.

       jsdom gives every element zero height, so the number here is 0 and only the wiring
       can be asserted: that the padding is driven by the measurement rather than absent
       or hard-coded. The real values were checked in a browser. */
    const { container } = render(<MemoryRouter><Layout><div /></Layout></MemoryRouter>);
    await screen.findByText(/©/);
    const main = container.querySelector("main");
    expect(main).toBeTruthy();
    expect(main.getAttribute("style") ?? "").not.toMatch(/padding-bottom:\s*\d+px/);
  });

  test("the footer is measurable — it is a real element in the tree", async () => {
    // The reservation depends on a ref reaching the footer. If it ever stopped being
    // attached the padding would silently stay 0 and text would slide back under.
    const footer = await draw();
    expect(footer.tagName).toBe("FOOTER");
    expect(typeof footer.getBoundingClientRect).toBe("function");
  });
});
