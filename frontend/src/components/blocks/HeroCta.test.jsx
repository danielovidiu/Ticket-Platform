/**
 * Hero and CTA banner: what the CMS controls, and what a block authored before those
 * controls existed still looks like.
 *
 * The second half matters as much as the first. These fields were added to blocks that
 * are already published, so "absent" has to keep meaning what it meant — otherwise the
 * upgrade silently restyles every live page.
 */
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BlockRenderer } from "./index";

const draw = (type, props) =>
  render(
    <MemoryRouter>
      <BlockRenderer block={{ block_id: "b1", type, enabled: true, props }} />
    </MemoryRouter>
  ).container;

describe("hero typography", () => {
  const heading = (props) => draw("hero", { heading: "Hello", ...props }).querySelector('[data-testid="hero-heading"]');
  const px = (el, key) => el.style.getPropertyValue(`--hero-heading-${key}`);

  test("size is a pixel value, not a slice of the browser window", () => {
    // It was `text-[10vw] md:text-[7vw]`, so the same heading was a different size in
    // the editor than on the site, and the CMS preview sized it from the whole window
    // while drawing it into a pane half that wide.
    const h = heading({ heading_size_desktop: 120, heading_size_mobile: 40 });
    expect(px(h, "desktop")).toBe("120px");
    expect(px(h, "mobile")).toBe("40px");
    expect(h.className).not.toMatch(/\[\d+vw\]/);
  });

  test("any pixel value in range is honoured, not just a few steps", () => {
    for (const size of [37, 61, 83, 149, 231]) {
      expect(px(heading({ heading_size_desktop: size }), "desktop")).toBe(`${size}px`);
    }
  });

  test("the two breakpoints are set independently", () => {
    const h = heading({ heading_size_desktop: 200, heading_size_mobile: 24 });
    expect(px(h, "desktop")).toBe("200px");
    expect(px(h, "mobile")).toBe("24px");
  });

  test("a value beyond the slider's range is clamped rather than rendered", () => {
    expect(px(heading({ heading_size_desktop: 9999 }), "desktop")).toBe("240px");
    expect(px(heading({ heading_size_mobile: -50 }), "mobile")).toBe("16px");
  });

  test("a fractional value is rounded to a whole pixel", () => {
    expect(px(heading({ heading_size_desktop: 72.6 }), "desktop")).toBe("73px");
  });

  test("rubbish falls back rather than rendering a broken size", () => {
    expect(px(heading({ heading_size_desktop: "abc" }), "desktop")).toBe("72px");
  });

  test.each([
    ["s", "36px", "30px"],
    ["m", "60px", "36px"],
    ["l", "72px", "48px"],
    ["xl", "96px", "60px"],
  ])("a block saved with the old %s step renders at exactly that size", (step, desktop, mobile) => {
    const h = heading({ heading_size: step });
    expect(px(h, "desktop")).toBe(desktop);
    expect(px(h, "mobile")).toBe(mobile);
  });

  test("a block with nothing set keeps the size it has always rendered at", () => {
    const h = heading({});
    expect(px(h, "desktop")).toBe("72px");
    expect(px(h, "mobile")).toBe("48px");
  });

  test("an explicit size wins over an old named step on the same block", () => {
    const h = heading({ heading_size: "s", heading_size_desktop: 150 });
    expect(px(h, "desktop")).toBe("150px");
    expect(px(h, "mobile")).toBe("30px"); // still the step, since only desktop was set
  });
});

describe("casing", () => {
  test("as-typed renders exactly what was written", () => {
    const h = draw("hero", { heading: "iPhone at eBay", text_case: "as-typed" }).querySelector('[data-testid="hero-heading"]');
    expect(h.className).toContain("normal-case");
    expect(h.textContent).toBe("iPhone at eBay");
  });

  test("a block authored before the setting existed keeps shouting", () => {
    // Absent must not mean "as typed", or every published hero restyles on deploy.
    const h = draw("hero", { heading: "Hello" }).querySelector('[data-testid="hero-heading"]');
    expect(h.className).toContain("uppercase");
  });

  test("the heading keeps the author's line breaks", () => {
    const h = draw("hero", { heading: "one\ntwo" }).querySelector('[data-testid="hero-heading"]');
    expect(h.className).toContain("whitespace-pre-wrap");
    expect(h.textContent).toBe("one\ntwo");
  });
});

describe("hero overlay", () => {
  test("no setting means the original treatment, unchanged", () => {
    const ov = draw("hero", { image_url: "/x.jpg" }).querySelector('[data-testid="hero-overlay"]');
    expect(ov.dataset.mode).toBe("gradient");
  });

  test("solid uses the configured colour and opacity", () => {
    const ov = draw("hero", { image_url: "/x.jpg", overlay: "solid", overlay_color: "#1166ff", overlay_opacity: 80 })
      .querySelector('[data-testid="hero-overlay"]');
    expect(ov.dataset.mode).toBe("solid");
    expect(ov.style.backgroundColor).toBe("rgb(17, 102, 255)");
    expect(ov.style.opacity).toBe("0.8");
  });

  test("none draws nothing over the image", () => {
    const c = draw("hero", { image_url: "/x.jpg", overlay: "none" });
    expect(c.querySelector('[data-testid="hero-overlay"]')).toBeNull();
  });

  test("an out-of-range opacity is clamped rather than passed through", () => {
    const ov = draw("hero", { image_url: "/x.jpg", overlay: "solid", overlay_opacity: 999 })
      .querySelector('[data-testid="hero-overlay"]');
    expect(ov.style.opacity).toBe("1");
  });
});

describe("hero full frame", () => {
  test("absent means edge to edge, as it always was", () => {
    const s = draw("hero", { heading: "x" }).querySelector('[data-testid="hero"]');
    expect(s.className).not.toContain("py-10");
  });

  test("turning it off holds the block inside the page frame", () => {
    const s = draw("hero", { heading: "x", full_frame: false }).querySelector('[data-testid="hero"]');
    expect(s.querySelector(".max-w-\\[1400px\\]")).toBeTruthy();
  });
});

describe("cta banner is authored, not hardcoded", () => {
  test("the eyebrow is the author's, not the literal string CTA", () => {
    const c = draw("cta_banner", { eyebrow: "Join the list", heading: "Hi" });
    expect(c.textContent).toContain("Join the list");
  });

  test("an image can stand in the left column", () => {
    const img = draw("cta_banner", { image_url: "/promo.jpg", heading: "Hi" }).querySelector('[data-testid="cta-image"]');
    expect(img.getAttribute("src")).toContain("/promo.jpg");
  });

  test("the button carries the authored label and link", () => {
    const b = draw("cta_banner", { cta_label: "Buy now", cta_href: "/events" }).querySelector('[data-testid="cta-button"]');
    expect(b.textContent).toBe("Buy now");
    expect(b.getAttribute("href")).toBe("/events");
  });

  test("the description keeps its line breaks", () => {
    const c = draw("cta_banner", { body: "line one\nline two" });
    expect(c.querySelectorAll("br").length).toBe(1);
  });

  test("a block with no eyebrow set still shows the original label", () => {
    const c = draw("cta_banner", { heading: "Hi" });
    expect(c.textContent).toContain("CTA");
  });
});
