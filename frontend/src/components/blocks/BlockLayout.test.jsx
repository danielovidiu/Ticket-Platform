/**
 * Two structural rules the block set now has to keep.
 *
 * 1. No block carries vertical padding. Page rhythm used to be decided by whoever wrote
 *    each block — two neighbours that happened to be py-24 and py-16 produced a gap
 *    nobody chose and nobody could change. Spacing is the Spacer block's job now, and
 *    this test is what stops a py-* creeping back in one block at a time.
 *
 * 2. Side gutters stay. They are not spacing between blocks, they are what keeps text
 *    off the edge of a phone, and Spacer has only a height so nothing could restore them.
 */
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BLOCK_RENDERERS, BlockRenderer, heroHeight, HERO_HEIGHT_LIMITS } from "./index";
import { BLOCK_DEFAULTS } from "../../lib/cms";

vi.mock("../../api", () => ({
  http: { get: vi.fn(() => Promise.resolve({ data: [] })), post: vi.fn() },
  API: "",
}));

const draw = (type, props) => {
  const { container } = render(
    <MemoryRouter>
      <BlockRenderer block={{ block_id: "b1", type, enabled: true, props: props ?? BLOCK_DEFAULTS[type]() }} />
    </MemoryRouter>
  );
  return container;
};

// The hero's text inset and the image band's sit over their own background image; they
// are internal composition, not the space between blocks, and a Spacer cannot restore
// them. Everything else must be flush.
const KEEPS_INTERNAL_INSET = new Set(["hero", "image_band"]);

describe("no block carries vertical padding", () => {
  const types = Object.keys(BLOCK_RENDERERS);

  test("every block type is covered by this test", () => {
    // Guards against a new block being added and quietly skipping the rule.
    expect(types.length).toBeGreaterThan(10);
    for (const t of types) expect(BLOCK_DEFAULTS[t], `${t} has no default props`).toBeTruthy();
  });

  test.each(types)("%s has no py-* on its outer section", (type) => {
    const container = draw(type);
    const section = container.querySelector("section");
    if (!section) return; // spacer renders a bare div, which is its whole point
    const offenders = [...section.classList].filter((c) => /^(py|pt|pb)-/.test(c));
    expect(offenders).toEqual([]);
  });

  test.each(types.filter((t) => !KEEPS_INTERNAL_INSET.has(t)))(
    "%s has no vertical padding anywhere in its frame", (type) => {
      const container = draw(type);
      const padded = [...container.querySelectorAll("*")].filter((el) =>
        [...el.classList].some((c) => /^(py|pt|pb)-\d/.test(c)));
      // Chips and editor placeholders are internal, not block spacing.
      const structural = padded.filter((el) => !el.className.includes("px-2 py-1")
        && !el.textContent.includes("Image not set"));
      expect(structural.map((e) => e.className)).toEqual([]);
    });

  test("the side gutters survive", () => {
    const container = draw("rich_text");
    expect(container.querySelector(".px-6")).toBeTruthy();
  });
});

describe("image band", () => {
  const band = (over = {}) => draw("image_band", { ...BLOCK_DEFAULTS.image_band(), ...over });

  test("its heading is an h2, not an h1", () => {
    // A page can carry several; only the hero claims to be the page's subject.
    const c = band({ heading: "A statement" });
    expect(c.querySelector("h2")).toHaveTextContent("A statement");
    expect(c.querySelector("h1")).toBeNull();
  });

  test("the overlay takes the chosen colour and opacity", () => {
    const c = band({ image_url: "/uploads/x.jpg", overlay_color: "#112233", overlay_opacity: 70 });
    const overlay = c.querySelector('[data-testid="image-band-overlay"]');
    expect(overlay.style.opacity).toBe("0.7");
    expect(overlay.style.backgroundColor).toBe("rgb(17, 34, 51)");
  });

  test("opacity is clamped rather than trusted", () => {
    expect(band({ image_url: "/x.jpg", overlay_opacity: 400 })
      .querySelector('[data-testid="image-band-overlay"]').style.opacity).toBe("1");
    expect(band({ image_url: "/x.jpg", overlay_opacity: -50 })
      .querySelector('[data-testid="image-band-overlay"]').style.opacity).toBe("0");
  });

  test("no image means no overlay to dim", () => {
    const c = band({ image_url: "" });
    expect(c.querySelector('[data-testid="image-band-overlay"]')).toBeNull();
    expect(c.querySelector("img")).toBeNull();
  });

  test("full width off holds it inside the 1400px frame", () => {
    expect(band({ full_width: false }).querySelector(".max-w-\\[1400px\\]")).toBeTruthy();
  });

  test("the CTA only renders when it has a label", () => {
    expect(band({ cta_label: "" }).querySelector("a")).toBeNull();
    expect(band({ cta_label: "Go", cta_href: "/events" }).querySelector("a"))
      .toHaveAttribute("href", "/events");
  });
});

/**
 * The hero's height, now a number rather than one of three names.
 *
 * The property that matters is that the names still resolve. A hero published as "tall"
 * has to render at the height it always did — the old select's three options were 50, 70
 * and 85vh, and nothing about a stored page changed when the control did.
 */
describe("hero height", () => {
  test("the names it replaced still resolve to their old values", () => {
    expect(heroHeight({ height: "short" })).toBe(50);
    expect(heroHeight({ height: "medium" })).toBe(70);
    expect(heroHeight({ height: "tall" })).toBe(85);
  });

  test("a hero with no height at all falls back rather than collapsing", () => {
    expect(heroHeight({})).toBe(HERO_HEIGHT_LIMITS.fallback);
  });

  test("a typed number wins over the legacy name", () => {
    expect(heroHeight({ height: "tall", height_vh: 30 })).toBe(30);
  });

  test("it is clamped, not trusted", () => {
    expect(heroHeight({ height_vh: 5000 })).toBe(HERO_HEIGHT_LIMITS.max);
    expect(heroHeight({ height_vh: -10 })).toBe(HERO_HEIGHT_LIMITS.min);
  });

  test("junk falls back instead of producing NaNvh", () => {
    for (const bad of ["", null, undefined, "abc", {}]) {
      expect(Number.isFinite(heroHeight({ height_vh: bad, height: "medium" }))).toBe(true);
    }
    expect(heroHeight({ height_vh: "abc", height: "medium" })).toBe(70);
  });

  test("0 is clamped to the minimum, not read as absent", () => {
    // A hero of zero height is a hero nobody can see; `||` would have sent it to 85.
    expect(heroHeight({ height_vh: 0 })).toBe(HERO_HEIGHT_LIMITS.min);
  });

  test("it reaches the rendered element as a vh min-height", () => {
    const c = draw("hero", { heading: "H", height_vh: 42 });
    expect(c.querySelector('[data-testid="hero"]').style.minHeight).toBe("42vh");
  });
});
