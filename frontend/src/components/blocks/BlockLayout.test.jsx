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

/** As `draw`, but as the CMS editor renders it. Only one block cares so far — the page
 *  background, which cannot be its real self inside a per-block preview row. */
const drawPreview = (type, props) => {
  const { container } = render(
    <MemoryRouter>
      <BlockRenderer preview block={{ block_id: "b1", type, enabled: true, props: props ?? BLOCK_DEFAULTS[type]() }} />
    </MemoryRouter>
  );
  return container;
};

// The hero's text inset and the image band's sit over their own background image; they
// are internal composition, not the space between blocks, and a Spacer cannot restore
// them. Everything else must be flush.
//
// The text panel joins them for a different reason: its inset is inside a scroll
// container of FIXED height, so it cannot change the space between blocks — the block
// occupies `height` either way. It only keeps the first and last lines off the scroll
// edges. (It was previously invisible to this rule because it used `p-6`, and the
// pattern below only matches `py-`, `pt-` and `pb-`.)
const KEEPS_INTERNAL_INSET = new Set(["hero", "image_band", "text_panel"]);

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
    expect(container.querySelector(".edge-inset")).toBeTruthy();
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
  // Edge to edge by nature, and so unset means bleeding: a ticker runs off both sides, a
  // page's backdrop covers the page, and a video is imagery rather than a framed player.
  // For these, turning the toggle OFF is what caps them. `_background` also names its own
  // key, because it frames the whole block rather than a band of content inside one.
  const BLEEDS_BY_DEFAULT = new Set(["marquee", "_background", "video"]);
  const FULL_KEY = { hero: "full_frame", _background: "full_frame" };

  const types = Object.keys(BLOCK_RENDERERS).filter((t) => !NO_CONTROL.has(t));
  // The video block renders nothing at all without a source, so there would be no frame
  // to assert about.
  const props = (type) => ({ ...BLOCK_DEFAULTS[type](), heading: "H", image_url: "/x.jpg",
                             url: "https://www.youtube.com/watch?v=abcdefghijk" });
  const capped = (c) => c.querySelector('[class*="max-w-["]');

  test.each(types)("%s is capped by default", (type) => {
    const c = draw(type, props(type));
    if (BLEEDS_BY_DEFAULT.has(type)) return expect(capped(c)).toBeNull();
    expect(capped(c), `${type} has no width cap`).toBeTruthy();
  });

  test.each(types.filter((t) => !TEXT_STAYS_FRAMED.has(t) && !BLEEDS_BY_DEFAULT.has(t)))(
    "%s drops its cap when set full width", (type) => {
      const c = draw(type, { ...props(type), [FULL_KEY[type] || "full_width"]: true });
      expect(capped(c), `${type} ignored full_width`).toBeNull();
    });

  test.each([...BLEEDS_BY_DEFAULT])("%s caps when its full-width toggle is switched off", (type) => {
    const c = draw(type, { ...props(type), [FULL_KEY[type] || "full_width"]: false });
    expect(capped(c), `${type} ignored being switched off`).toBeTruthy();
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

  test("the frame's own gutters go with the cap — full width reaches the edge", () => {
    // The FRAME still surrenders its gutters, so the media inside it bleeds. What
    // changed is that the text no longer goes with it — see the edge-inset suite below.
    const c = draw("events_grid", { ...BLOCK_DEFAULTS.events_grid(), full_width: true });
    const frame = c.querySelector("section > div");
    expect([...frame.classList]).not.toContain("edge-inset");
  });

  test("a contained block still has its gutters", () => {
    const c = draw("events_grid", BLOCK_DEFAULTS.events_grid());
    expect(c.querySelector(".edge-inset")).toBeTruthy();
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

  /* It is an <img> that drifts, not `background-attachment: fixed`, and the reasons are
   * two bugs that both came from the same rule: a fixed background's positioning area is
   * the VIEWPORT, not the element.
   *
   *   It zoomed — `cover` sized the photo to the viewport's full height while the band
   *   showed a 45vh window, measured at 1.72x. That could not be tuned away: a
   *   viewport-pinned image must cover the viewport or bands elsewhere on screen show
   *   gaps, so the zoom was the price of the technique.
   *
   *   It was invisible on phones — mobile browsers ignore the property, so the photo had
   *   to be hidden below md and the band went flat.
   */
  test("set, it is still one photograph, carried by an img", () => {
    const c = band({ image_url: "/x.jpg", fixed_bg: true });
    const layer = c.querySelector('[data-testid="image-band-fixed"]');
    expect(layer).toBeTruthy();
    const img = layer.querySelector('[data-testid="image-band-parallax-img"]');
    expect(img.tagName).toBe("IMG");
    expect(img.getAttribute("src")).toContain("/x.jpg");
    // Nothing left that a mobile browser refuses to honour.
    expect(layer.querySelector(".bg-fixed")).toBeNull();
  });

  test("it is not hidden on phones", () => {
    const layer = band({ image_url: "/x.jpg", fixed_bg: true })
      .querySelector('[data-testid="image-band-fixed"]');
    expect([...layer.classList]).not.toContain("hidden");
    const img = layer.querySelector('[data-testid="image-band-parallax-img"]');
    expect([...img.classList]).not.toContain("md:hidden");
    expect([...img.classList]).not.toContain("hidden");
  });

  test("the photo keeps its own proportions, with the band height only as a floor", () => {
    // This is what stops it zooming. Fitted to the band's WIDTH and left at its natural
    // aspect, any surplus height is real rather than invented — and that surplus, not a
    // fixed percentage, is the only room it drifts in. `min-h-full` is the floor that
    // keeps a wide panorama from leaving a gap; object-cover crops rather than stretches
    // when that floor is what applies.
    const img = band({ image_url: "/x.jpg", fixed_bg: true })
      .querySelector('[data-testid="image-band-parallax-img"]');
    const cls = [...img.classList];
    expect(cls).toContain("h-auto");
    expect(cls).toContain("min-h-full");
    expect(cls).toContain("w-full");
    expect(cls).toContain("object-cover");
    // Never a fixed taller box: on a band too narrow to supply surplus for free, drawing
    // one 24% taller cost 24% zoom — measured at 1.24x on a 375x365 phone band.
    expect(img.style.height).toBe("");
  });

  test("it starts centred, so an unscrolled band is framed like a plain cover", () => {
    const img = band({ image_url: "/x.jpg", fixed_bg: true })
      .querySelector('[data-testid="image-band-parallax-img"]');
    expect([...img.classList]).toContain("top-1/2");
    expect(img.style.transform).toMatch(/calc\(-50% \+ 0px\)/);
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

  test("it draws no border", () => {
    // It is a window onto text, not a boxed-off card. The border was the only thing
    // making this block look unlike the rest of the page.
    const cls = [...panel({}).classList].join(" ");
    expect(cls).not.toMatch(/\bborder\b/);
  });

  test("it does not indent its text horizontally", () => {
    // With no border drawn, side padding would be an unexplained indent: the panel's
    // prose would not line up with any other block on the page.
    const cls = [...panel({}).classList];
    expect(cls).toContain("py-6");
    expect(cls).not.toContain("p-6");
  });

  test("its prose is the same type as Rich text", () => {
    // A reader should not be able to tell which of the two blocks they are in.
    const el = draw("text_panel", { ...BLOCK_DEFAULTS.text_panel(), content: "Hello there." });
    const para = el.querySelector("p");
    const rich = draw("rich_text", { ...BLOCK_DEFAULTS.rich_text(), content: "Hello there." })
      .querySelector("p");
    for (const c of ["text-lg", "leading-relaxed", "text-ink-2"]) {
      expect([...para.classList]).toContain(c);
      expect([...rich.classList]).toContain(c);
    }
  });

  test("but it keeps its own Width control, which Rich text's measure would override", () => {
    // max-w-2xl is 672px. Copying it wholesale would cap "wide" (1200px) at narrower
    // than "normal" (900px), making two of the three Width options do nothing.
    const el = draw("text_panel", { ...BLOCK_DEFAULTS.text_panel(), width: "wide", content: "Body." });
    const panelEl = el.querySelector('[data-testid="text-panel"]');
    expect([...panelEl.classList]).toContain("max-w-[1200px]");
    expect([...el.querySelector("p").classList]).not.toContain("max-w-2xl");
  });

  test("a list is set to the same measure as the paragraphs around it", () => {
    // Lists used to be hardcoded to max-w-2xl, so widening the prose left the bullets
    // behind at a different measure inside the same block.
    const el = draw("text_panel", {
      ...BLOCK_DEFAULTS.text_panel(), width: "wide", content: "Intro.\n\n- one\n- two",
    });
    const list = el.querySelector("ul");
    expect(list).toBeTruthy();
    expect([...list.classList]).not.toContain("max-w-2xl");
    expect([...list.classList]).toContain("text-lg");
  });

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

/**
 * The page background, and the two things about it that are not obvious.
 *
 * It is the only block that does not sit in the run of blocks — everything else on the
 * page paints on top of it — and it is the only one that renders something different in
 * the editor than on the page.
 */
describe("the page background", () => {
  const bg = (over) => draw("_background", { ...BLOCK_DEFAULTS._background(), ...over });

  test("is pinned rather than scrolling", () => {
    const el = bg({ image_url: "/x.jpg" }).querySelector('[data-testid="page-background"]');
    expect([...el.classList]).toContain("sticky");
    expect([...el.classList]).toContain("top-0");
  });

  test("takes its own height back out of the layout", () => {
    // A full-height element in normal flow would push every block down by a screenful.
    const el = bg({ image_url: "/x.jpg" }).querySelector('[data-testid="page-background"]');
    expect([...el.classList]).toContain("h-screen");
    expect([...el.classList]).toContain("-mb-[100vh]");
  });

  test("does not use a negative z-index", () => {
    // The obvious way, and it does not work: a negative-z child paints above its stacking
    // context's own background but still below every in-flow block box, and the app wraps
    // its pages in an opaque .App div — so the backdrop went behind that and vanished.
    // DynamicPage places it at z-0 and the blocks at z-10 instead.
    const el = bg({ image_url: "/x.jpg" }).querySelector('[data-testid="page-background"]');
    expect([...el.classList]).toContain("z-0");
    expect([...el.classList].some((c) => c.startsWith("-z-"))).toBe(false);
  });

  test("never swallows a click meant for the content above it", () => {
    const el = bg({ image_url: "/x.jpg" }).querySelector('[data-testid="page-background"]');
    expect([...el.classList]).toContain("pointer-events-none");
    expect(el.getAttribute("aria-hidden")).toBe("true");
  });

  test("draws the overlay even with no photo, so the colour alone is usable", () => {
    const c = bg({ image_url: "" });
    expect(c.querySelector('[data-testid="page-background-img"]')).toBeNull();
    expect(c.querySelector('[data-testid="page-background-overlay"]')).toBeTruthy();
  });

  test("the overlay's opacity is a percentage, clamped", () => {
    const at = (v) => bg({ image_url: "/x.jpg", overlay_opacity: v })
      .querySelector('[data-testid="page-background-overlay"]').style.opacity;
    expect(at(0)).toBe("0");
    expect(at(50)).toBe("0.5");
    expect(at(400)).toBe("1");
    expect(at(-20)).toBe("0");
  });

  test("full frame off holds it inside the same 1400px measure as everything else", () => {
    const inner = bg({ image_url: "/x.jpg", full_frame: false })
      .querySelector('[data-testid="page-background"]').firstElementChild;
    expect([...inner.classList]).toContain("max-w-[1400px]");
  });

  test("in the editor it is a band you can see, not the real backdrop", () => {
    // The preview renders one block per row, each in its own wrapper, so a sticky
    // full-height layer would have a zero-height containing block to stick inside and
    // would cover the blocks after it instead of sitting under them.
    const c = drawPreview("_background", { ...BLOCK_DEFAULTS._background(), image_url: "/x.jpg" });
    expect(c.querySelector('[data-testid="page-background-preview"]')).toBeTruthy();
    expect(c.querySelector('[data-testid="page-background"]')).toBeNull();
  });
});

/**
 * Text never touches the glass; photographs always may.
 *
 * Some screens curve at the edge, and a letter that reaches the glass loses a sliver of
 * itself to the bend — which reads as a rendering fault, not as a design. A photograph
 * loses the same two pixels and nobody can tell.
 *
 * So the rule is asymmetric on purpose, and these tests are the rule: with "Full width"
 * on, every block below still holds its TYPE off the edge, and the named media keeps
 * running to the corner. Hero and Image band are absent because they already did this —
 * their image is `absolute inset-0` and their text sits in a Container — and they are
 * what the rest were made to match.
 */
describe("text is held off the screen edge", () => {
  const full = (type, over) =>
    draw(type, { ...BLOCK_DEFAULTS[type](), full_width: true, ...over });

  /** The inset is on the element itself or on something above it — either keeps the text
   *  off the edge, and pinning which one would pin the markup rather than the rule. */
  const inset = (el) => !!el?.closest(".edge-inset");
  const text = (c, sel) => c.querySelector(sel);

  test.each([
    ["rich_text", "p", { content: "Body." }],
    ["text_panel", "p", { content: "Body." }],
    ["contact_form", "form", {}],
    ["newsletter", "form", {}],
    ["artists_grid", "h2", { heading: "Artists" }],
    ["events_grid", "h2", { heading: "Events" }],
    ["gallery_grid", "h2", { heading: "Gallery" }],
    ["split", "h2", { heading: "Split" }],
    ["split_audio", "h2", { heading: "Split" }],
    ["video", '[data-testid="video-caption"]', { caption: "A caption", file_url: "/v.mp4" }],
  ])("%s keeps its text inset at full width", (type, sel, over) => {
    const c = full(type, over);
    const el = text(c, sel);
    expect(el, `${type}: no element matched ${sel}`).toBeTruthy();
    expect(inset(el), `${type} put its text against the screen edge`).toBe(true);
  });

  test("a gallery photograph still reaches the edge", () => {
    // The block the rule is asymmetric FOR. Insetting these would put a grey margin
    // around a wall of photographs, which is the thing full width exists to avoid.
    const c = full("gallery_grid", { heading: "Gallery" });
    const fig = c.querySelector("figure");
    if (fig) expect(inset(fig)).toBe(false);
  });

  test("a split's image is left at the edge while its text moves in", () => {
    // Asked for explicitly: the fix applies to the words, not the picture.
    const c = full("split", { heading: "Split", image_url: "/i.jpg" });
    expect(inset(c.querySelector("img"))).toBe(false);
    expect(inset(c.querySelector("h2"))).toBe(true);
  });

  test("a split + audio block keeps its photograph at the edge too", () => {
    // Same bargain as Split, which it is built from: the words move in, the picture does
    // not — and here the picture carries no hairline either, so anything holding it off
    // the edge would show as a gap rather than as a frame.
    const c = full("split_audio", { heading: "Split", image_url: "/i.jpg" });
    expect(inset(c.querySelector('[data-testid="split-audio-image"]'))).toBe(false);
    expect(inset(c.querySelector("h2"))).toBe(true);
  });

  test("nothing is inset twice when the block is not full width", () => {
    // A capped block already sits inside the Frame's inset. A second helping would
    // double the gutter and pull the text away from every other block on the page.
    for (const type of ["rich_text", "contact_form", "newsletter", "artists_grid"]) {
      const c = draw(type, { ...BLOCK_DEFAULTS[type](), full_width: false, heading: "H", content: "B." });
      const nested = [...c.querySelectorAll(".edge-inset .edge-inset")];
      expect(nested, `${type} applied the inset twice`).toEqual([]);
    }
  });
});
