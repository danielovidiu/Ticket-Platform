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
  test("size is a fixed step, not a slice of the browser window", () => {
    // It was `text-[10vw] md:text-[7vw]`, so the same heading was a different size in
    // the editor than on the site, and the CMS preview sized it from the whole window
    // while drawing it into a pane half that wide.
    const h = draw("hero", { heading: "Hello", heading_size: "l" }).querySelector('[data-testid="hero-heading"]');
    expect(h.className).toContain("text-5xl");
    expect(h.className).not.toMatch(/\[\d+vw\]/);
  });

  test.each([["s", "text-3xl"], ["m", "text-4xl"], ["l", "text-5xl"], ["xl", "text-6xl"]])(
    "size %s is honoured", (size, cls) => {
      const h = draw("hero", { heading: "Hello", heading_size: size }).querySelector('[data-testid="hero-heading"]');
      expect(h.className).toContain(cls);
    }
  );

  test("a block with no size set gets a stable default rather than a viewport slice", () => {
    const h = draw("hero", { heading: "Hello" }).querySelector('[data-testid="hero-heading"]');
    expect(h.className).toContain("text-5xl");
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
