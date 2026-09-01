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

/**
 * The bug this fixes, pinned so it cannot come back.
 *
 * `Container` carries `mx-auto`. Inside a flex COLUMN — which the hero and the image band
 * both are — that sets auto margins on the cross axis, and an auto cross-axis margin
 * suppresses the default `stretch`. The container shrink-wrapped its own text and the
 * auto margins centred that box, so a hero set to align LEFT drew its heading a third of
 * the way across the screen: correctly left-aligned, inside a box floating in the middle.
 *
 * jsdom does no layout, so the widths cannot be measured here. What is testable is the
 * declaration that produces them.
 */
describe("the container fills its flex parent", () => {
  test("the frame asks for full width before capping it", () => {
    // rich_text uses the 900px reading measure, so this pins a block on the wide one.
    const c = draw("events_grid");
    const el = c.querySelector(".max-w-\\[1400px\\]");
    expect([...el.classList]).toContain("w-full");
    expect([...el.classList]).toContain("mx-auto");
  });

  test("the narrow blocks cap at a reading measure, still full width first", () => {
    // A line of text 1400px wide is one the eye loses its place in.
    for (const type of ["rich_text", "contact_form", "newsletter"]) {
      const el = draw(type).querySelector(".max-w-\\[900px\\]");
      expect(el, `${type} lost its reading measure`).toBeTruthy();
      expect([...el.classList]).toContain("w-full");
    }
  });

  test.each(["hero", "image_band"])("%s's inner container is full width", (type) => {
    const c = draw(type, { ...BLOCK_DEFAULTS[type](), heading: "H", image_url: "/x.jpg" });
    const el = c.querySelector(".max-w-\\[1400px\\].w-full");
    expect(el, "the block whose flex column caused the bug must stretch").toBeTruthy();
  });
});

describe("vertical text position", () => {
  /* The hero's is a percentage now — three named steps could put its words in three
   * places and nowhere else, and on a photograph the spot they need is usually none of
   * the three, because a face or a horizon is in the way.
   *
   * It is read off the two spacers that place the text rather than off a class: flex-grow
   * shares out only the space that is actually free, so text taller than its block fills
   * it instead of hanging out of the bottom the way `top: 100%` would. */
  const heroOffset = (c) => Number(c.querySelector('[data-testid="hero"]').dataset.contentOffset);
  const beforeGrow = (c) => c.querySelector('[data-testid="hero-space-before"]').style.flexGrow;
  const afterGrow = (c) => c.querySelector('[data-testid="hero-space-after"]').style.flexGrow;
  const bandY = (c) => [...c.querySelector('[data-testid="image-band"]').classList]
    .find((x) => x.startsWith("justify-"));

  test("the hero still sits at the bottom when unset", () => {
    // Absent means the position it shipped with; nothing published may move.
    const c = draw("hero", { heading: "H" });
    expect(heroOffset(c)).toBe(100);
    expect(beforeGrow(c)).toBe("100");
    expect(afterGrow(c)).toBe("0");
  });

  test("a hero published under a named step keeps exactly where it sat", () => {
    // The upgrade path. These three were the whole vocabulary before the slider.
    expect(heroOffset(draw("hero", { heading: "H", content_y: "top" }))).toBe(0);
    expect(heroOffset(draw("hero", { heading: "H", content_y: "middle" }))).toBe(50);
    expect(heroOffset(draw("hero", { heading: "H", content_y: "bottom" }))).toBe(100);
  });

  test("the slider wins over the old step where both are present", () => {
    expect(heroOffset(draw("hero", { heading: "H", content_y: "top", content_offset: 62 }))).toBe(62);
  });

  test("the spacers split in proportion, so 30% means 30% down", () => {
    const c = draw("hero", { heading: "H", content_offset: 30 });
    expect(beforeGrow(c)).toBe("30");
    expect(afterGrow(c)).toBe("70");
  });

  test("out-of-range values are clamped rather than breaking the layout", () => {
    expect(heroOffset(draw("hero", { heading: "H", content_offset: 400 }))).toBe(100);
    expect(heroOffset(draw("hero", { heading: "H", content_offset: -20 }))).toBe(0);
  });

  test("a value that is not a number falls back rather than rendering NaN", () => {
    const c = draw("hero", { heading: "H", content_offset: "sideways" });
    expect(heroOffset(c)).toBe(100);
    expect(beforeGrow(c)).toBe("100");
  });

  // The band kept the three steps: it is a strip of fixed height, not a full screen, so
  // there is far less room in which a percentage would mean anything different.
  test("the band still centres when unset", () => {
    expect(bandY(draw("image_band", { heading: "H" }))).toBe("justify-center");
  });

  test.each([["top", "justify-start"], ["middle", "justify-center"], ["bottom", "justify-end"]])(
    "the band's %s maps to %s", (pos, cls) => {
      expect(bandY(draw("image_band", { heading: "H", content_y: pos }))).toBe(cls);
    });
});

/**
 * Every block can go edge to edge.
 *
 * Spacer is the one exception and is asserted as such: it is an empty div with a height,
 * so contained and edge-to-edge render identically and a toggle would visibly do nothing
 * — the same bug the hero's overlay boolean had, where the panel offered a control that
 * changed nothing.
 */
describe("full width", () => {
  // Spacer has no content to frame: it is an empty div with a height, so contained and
  // edge-to-edge render identically and a toggle would visibly do nothing.
  const NO_CONTROL = new Set(["spacer"]);
  // Hero and the image band cap their TEXT even when the block bleeds — the background
  // spans the viewport, the words stay in the frame so a heading is not 1400px wide on a
  // desktop. Their toggle is about the block, not about every element inside it.
  const TEXT_STAYS_FRAMED = new Set(["hero", "image_band"]);

  const types = Object.keys(BLOCK_RENDERERS).filter((t) => !NO_CONTROL.has(t));
  // The video block renders nothing at all without a source, so there would be no frame
  // to assert about.
  const props = (type) => ({ ...BLOCK_DEFAULTS[type](), heading: "H", image_url: "/x.jpg",
                             url: "https://www.youtube.com/watch?v=abcdefghijk" });
  const capped = (c) => c.querySelector('[class*="max-w-["]');

  test.each(types)("%s is capped by default", (type) => {
    const c = draw(type, props(type));
    // marquee is the exception in the other direction: a ticker is edge-to-edge by
    // nature, so unset means bleeding and turning it OFF is what caps it.
    if (type === "marquee") return expect(capped(c)).toBeNull();
    expect(capped(c), `${type} has no width cap`).toBeTruthy();
  });

  test.each(types.filter((t) => !TEXT_STAYS_FRAMED.has(t)))(
    "%s drops its cap when set full width", (type) => {
      const c = draw(type, { ...props(type), full_width: true });
      expect(capped(c), `${type} ignored full_width`).toBeNull();
    });

  test.each([...TEXT_STAYS_FRAMED])(
    "%s bleeds its background but keeps its text framed", (type) => {
      const key = type === "hero" ? "full_frame" : "full_width";
      const c = draw(type, { ...props(type), [key]: true });
      const section = c.querySelector("section");
      // The block itself is not capped...
      expect([...section.classList].some((x) => x.startsWith("max-w-"))).toBe(false);
      // ...but the words inside it still are.
      expect(capped(c), `${type} let its text run the full width`).toBeTruthy();
    });

  test("marquee caps when full_width is switched off", () => {
    const c = draw("marquee", { ...BLOCK_DEFAULTS.marquee(), full_width: false });
    expect(capped(c)).toBeTruthy();
  });

  test("the gutters go with the cap — full width means edge to edge", () => {
    // This asserted the opposite until the label was taken at its word. A toggle saying
    // "edge to edge" that left 40px on each side was a promise the code did not keep.
    const c = draw("events_grid", { ...BLOCK_DEFAULTS.events_grid(), full_width: true });
    const frame = c.querySelector("section > div");
    expect([...frame.classList]).not.toContain("px-6");
    expect([...frame.classList]).not.toContain("md:px-10");
  });

  test("a contained block still has its gutters", () => {
    // The default is unchanged: text off the edge of a phone, unless asked otherwise.
    const c = draw("events_grid", BLOCK_DEFAULTS.events_grid());
    expect(c.querySelector(".px-6")).toBeTruthy();
  });
});

/**
 * A background that stays put while the band scrolls over it.
 *
 * It is a background-image with `bg-fixed`, not an <img>, because that is the only thing
 * background-attachment applies to. Mobile browsers — iOS Safari in particular — IGNORE
 * background-attachment and render a badly-cropped still instead, so the fixed variant
 * shows NO photo below md rather than a broken version of the effect.
 */
describe("image band, fixed background", () => {
  const band = (over) => draw("image_band", { ...BLOCK_DEFAULTS.image_band(), ...over });

  test("unset, it is still a plain image", () => {
    const c = band({ image_url: "/x.jpg" });
    expect(c.querySelector("img")).toBeTruthy();
    expect(c.querySelector('[data-testid="image-band-fixed"]')).toBeNull();
  });

  test("set, the desktop layer is a fixed background rather than an img", () => {
    const c = band({ image_url: "/x.jpg", fixed_bg: true });
    const fixed = c.querySelector('[data-testid="image-band-fixed"]');
    expect(fixed).toBeTruthy();
    const pinned = fixed.querySelector(".bg-fixed");
    expect(pinned).toBeTruthy();
    expect([...pinned.classList]).toContain("md:block");
    expect([...pinned.classList]).toContain("hidden");
  });

  test("a phone gets the photograph, just not the parallax", () => {
    // background-attachment: fixed is ignored by iOS Safari and most mobile browsers.
    // This used to be handled by hiding the whole layer below md, which meant a phone
    // got NO photo — the band collapsed to a flat colour and read as broken rather than
    // as less fancy. The same image is served as a plain <img> instead.
    const fixed = band({ image_url: "/x.jpg", fixed_bg: true })
      .querySelector('[data-testid="image-band-fixed"]');
    expect([...fixed.classList]).not.toContain("hidden");

    const fallback = fixed.querySelector('[data-testid="image-band-fixed-fallback"]');
    expect(fallback).toBeTruthy();
    expect(fallback.tagName).toBe("IMG");
    expect(fallback.getAttribute("src")).toContain("/x.jpg");
    // And it steps aside once the real effect is available.
    expect([...fallback.classList]).toContain("md:hidden");
  });

  test("the overlay still dims it", () => {
    const c = band({ image_url: "/x.jpg", fixed_bg: true, overlay_opacity: 70 });
    expect(c.querySelector('[data-testid="image-band-overlay"]').style.opacity).toBe("0.7");
  });

  test("no image means no background either way", () => {
    expect(band({ image_url: "", fixed_bg: true })
      .querySelector('[data-testid="image-band-fixed"]')).toBeNull();
  });
});

/**
 * The scrolling text panel.
 *
 * A box of FIXED height holding text of any length: the page keeps its shape and the
 * words scroll inside rather than pushing everything below them down. Its scrollbar is
 * deliberately visible — the blocks that hide theirs have incidental overflow, whereas
 * here the overflow is the whole feature and a box with no scrollbar looks truncated.
 */
describe("text panel", () => {
  const panel = (over) => draw("text_panel", { ...BLOCK_DEFAULTS.text_panel(), ...over })
    .querySelector('[data-testid="text-panel"]');

  test("it has a height and scrolls inside it", () => {
    const el = panel({ height: 400 });
    expect(el.style.height).toBe("400px");
    expect([...el.classList]).toContain("overflow-y-auto");
  });

  test("the height is clamped, and 0 goes to the floor rather than the default", () => {
    expect(panel({ height: 99999 }).style.height).toBe("1200px");
    expect(panel({ height: 0 }).style.height).toBe("80px");
  });

  test("junk falls back rather than reaching the DOM as NaNpx", () => {
    for (const bad of ["", null, "abc"]) {
      expect(panel({ height: bad }).style.height).toMatch(/^\d+px$/);
    }
  });

  test.each([["narrow", "max-w-[640px]"], ["normal", "max-w-[900px]"], ["wide", "max-w-[1200px]"]])(
    "width %s caps at %s", (width, cls) => {
      expect([...panel({ width }).classList]).toContain(cls);
    });

  test("full width drops the cap entirely", () => {
    const el = panel({ full_width: true });
    expect([...el.classList].some((c) => c.startsWith("max-w-"))).toBe(false);
    expect([...el.classList]).toContain("w-full");
  });

  test.each([["left", "mr-auto"], ["center", "mx-auto"], ["right", "ml-auto"]])(
    "panel position %s uses %s", (align, cls) => {
      expect([...panel({ align }).classList]).toContain(cls);
    });

  test("where the panel sits and how its text aligns are separate questions", () => {
    const el = panel({ align: "right", text_align: "center" });
    expect([...el.classList]).toContain("ml-auto");
    expect([...el.classList]).toContain("text-center");
  });

  test("the heading is optional", () => {
    expect(panel({ heading: "" }).querySelector("h2")).toBeNull();
    expect(panel({ heading: "Manifesto" }).querySelector("h2")).toHaveTextContent("Manifesto");
  });

  test("the content renders as rich text", () => {
    expect(panel({ content: "**bold** words" }).querySelector("strong"))
      .toHaveTextContent("bold");
  });
});
