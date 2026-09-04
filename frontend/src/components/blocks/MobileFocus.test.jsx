/**
 * Which part of a photograph survives the crop on a phone.
 *
 * The block fills its box with `object-cover` and throws the overflow away. On a wide
 * screen that costs the top and bottom of the picture; on a 375px screen it costs most of
 * the WIDTH, and a subject standing at the edge of the frame is cropped out entirely.
 *
 * Two properties are asserted, and the second is the one that protects everything already
 * published: the control changes the phone view, and it changes NOTHING on a wide screen,
 * where no inline position is written at all.
 */
import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BlockRenderer } from "./index";

/** jsdom has matchMedia but no layout, so the breakpoint is driven directly. */
let mobile = false;
const listeners = new Set();
beforeEach(() => {
  mobile = false;
  listeners.clear();
  window.matchMedia = (q) => ({
    matches: q.includes("max-width: 767px") ? mobile : false,
    media: q,
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
  });
});
const setMobile = (v) => act(() => { mobile = v; listeners.forEach((fn) => fn()); });

const draw = (type, props) =>
  render(
    <MemoryRouter>
      <BlockRenderer block={{ block_id: "b1", type, enabled: true, props }} />
    </MemoryRouter>
  ).container;

describe.each([
  ["hero", "hero-image"],
  ["image_band", "image-band-image"],
])("%s: mobile view", (type, testId) => {
  const image = (props) => draw(type, { image_url: "/p.jpg", ...props }).querySelector(`[data-testid="${testId}"]`);

  test("on a wide screen nothing is written, whatever the setting says", () => {
    // The guarantee for every page already published: desktop rendering is untouched.
    expect(image({ mobile_focus: "left" }).style.objectPosition).toBe("");
    expect(image({ mobile_focus: "right" }).style.objectPosition).toBe("");
  });

  test("on a phone the chosen side is the side that is kept", () => {
    setMobile(true);
    expect(image({ mobile_focus: "left" }).style.objectPosition).toBe("0% 50%");
    expect(image({ mobile_focus: "right" }).style.objectPosition).toBe("100% 50%");
    expect(image({ mobile_focus: "center" }).style.objectPosition).toBe("50% 50%");
  });

  test("a block that predates the control is centred, which is what it always did", () => {
    setMobile(true);
    expect(image({}).style.objectPosition).toBe("50% 50%");
  });

  test("a value nobody offers is treated as centre rather than dropped", () => {
    setMobile(true);
    expect(image({ mobile_focus: "diagonal" }).style.objectPosition).toBe("50% 50%");
  });
});

describe("the band's fixed photograph", () => {
  test("has no still crop to move, so it is left alone", () => {
    // It is drawn at the band's full width with its height free — there is no horizontal
    // overflow for a focal point to choose from. The panel hides the control there too.
    setMobile(true);
    const c = draw("image_band", { image_url: "/p.jpg", fixed_bg: true, mobile_focus: "left" });
    expect(c.querySelector('[data-testid="image-band-image"]')).toBeNull();
    expect(c.querySelector('[data-testid="image-band-parallax-img"]').style.objectPosition).toBe("");
  });
});
