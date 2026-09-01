/**
 * Where the nav bar lives at each width.
 *
 * The nav used to appear only from `lg`, so a tablet got the phone treatment: a hamburger
 * hiding seven links on a device with a pointer and room to show them. Moving it to `md`
 * alone was NOT enough and shipped a worse bug for a few minutes — seven links, the
 * wordmark and two buttons need about 880px in one line and a tablet has 768, so the nav
 * scrolled inside 271px with Gallery, Events, Shop and Contact off the end, behind a
 * scrollbar that is deliberately invisible. Fewer reachable links than the hamburger it
 * replaced.
 *
 * So between md and lg the nav takes a row of its own, and rejoins the line at lg.
 *
 * jsdom does no layout, so the widths cannot be measured here — what is testable is the
 * declaration that produces them, which is what regressed.
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Layout from "./Layout";

// The bar is rendered from /cms/nav, so an empty mock would make the link assertions
// pass vacuously against a nav with nothing in it. The list lives inside the factory
// because vi.mock is hoisted above every const in the file.
vi.mock("../api", () => ({
  http: {
    get: vi.fn((url) => Promise.resolve({
      data: String(url).includes("nav")
        ? [{ label: "Home", route: "/" }, { label: "Manifesto", route: "/manifesto" },
           { label: "Artists", route: "/artists" }, { label: "Gallery", route: "/gallery" },
           { label: "Events", route: "/events" }, { label: "Shop", route: "/shop" },
           { label: "Contact", route: "/contact" }]
        : [],
    })),
  },
  API: "",
}));
vi.mock("../auth", () => ({
  useAuth: () => ({ user: null, logout: vi.fn(), loading: false }),
  startLogin: vi.fn(),
}));
vi.mock("./CookieConsent", () => ({ default: () => null }));

let container;
const header = () => container.querySelector("header");

const nav = () => header().querySelector("nav");
const toggle = () => header().querySelector('[data-testid="menu-toggle"]');

beforeEach(async () => {
  ({ container } = render(<MemoryRouter><Layout><div /></Layout></MemoryRouter>));
  await screen.findByText("Events", { selector: "header nav a" });
});

describe("which control appears where", () => {
  test("the nav is hidden on phones and shown from md up", () => {
    const cls = [...nav().classList];
    expect(cls).toContain("hidden");
    expect(cls).toContain("md:flex");
    expect(cls).not.toContain("lg:flex");
  });

  test("the hamburger is the phone-only fallback", () => {
    // It used to be lg:hidden, which is what gave tablets the phone treatment.
    expect([...toggle().classList]).toContain("md:hidden");
    expect([...toggle().classList]).not.toContain("lg:hidden");
  });

  test("every nav link is in the DOM, not dropped by width", () => {
    // Whatever CSS hides, the markup carries the whole list — so "hidden on a tablet"
    // was always a styling decision, never missing content.
    expect([...nav().querySelectorAll("a")].map((a) => a.textContent))
      .toEqual(["Home", "Manifesto", "Artists", "Gallery", "Events", "Shop", "Contact"]);
  });
});

describe("the tablet row", () => {
  test("the nav takes the full width on its own line, and rejoins at lg", () => {
    const cls = [...nav().classList];
    expect(cls).toContain("w-full");
    expect(cls).toContain("lg:w-auto");
    expect(cls).toContain("order-last");
    expect(cls).toContain("lg:order-none");
  });

  test("the header row is allowed to wrap", () => {
    // Without this the nav cannot drop to a second line and goes back to scrolling.
    const row = header().querySelector("div");
    expect([...row.classList]).toContain("flex-wrap");
  });

  test("the nav still scrolls rather than clipping if it ever overflows", () => {
    // A very long nav degrades by scrolling, not by disappearing.
    expect([...nav().classList]).toContain("overflow-x-auto");
  });
});

/**
 * Where the page ends.
 *
 * The footer carried `mt-24` — 96px between the last block and the footer, which is the
 * same kind of gap the flush-blocks pass removed from between every other pair of
 * blocks: spacing decided by a component rather than by whoever composes the page.
 */
describe("the join between the page and the footer", () => {
  const footer = () => header().parentElement.querySelector("footer");

  test("the footer has no margin above it", () => {
    expect([...footer().classList].some((c) => /^mt-/.test(c))).toBe(false);
  });

  test("it keeps its own internal padding", () => {
    // That is the footer's breathing room, not space between it and the page — the same
    // call as the hero's text inset.
    expect(footer().querySelector(".py-14")).toBeTruthy();
  });

  test("the hairline is still the join", () => {
    expect([...footer().classList]).toContain("hairline");
  });
});
