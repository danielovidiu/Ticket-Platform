/**
 * The video block's shape, which is the half of "make it look right on mobile" that CSS
 * can answer.
 *
 * One aspect ratio cannot serve both orientations: 16:9 on a 375px phone is a 211px
 * strip. The reference this was modelled on (alexandermcqueen.com, measured at both
 * sizes) runs 16:9 at 1440 wide and 9:16 at 375 — full-bleed either way, with the
 * container following the DEVICE's orientation so the video fills the screen instead of
 * shrinking to keep one ratio.
 */
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BlockRenderer } from "./index";
import { BLOCK_DEFAULTS } from "../../lib/cms";

vi.mock("../../api", () => ({
  http: { get: vi.fn(() => Promise.resolve({ data: [] })), post: vi.fn() },
  API: "",
}));

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

const draw = (props) => {
  const { container } = render(
    <MemoryRouter>
      <BlockRenderer block={{ block_id: "b1", type: "video", enabled: true,
                              props: { ...BLOCK_DEFAULTS.video(), ...props } }} />
    </MemoryRouter>
  );
  return container;
};
const box = (c) => c.querySelector('[data-testid="video-file"]').parentElement;

describe("what a new video block is", () => {
  test("a silent looping backdrop rather than a player", () => {
    const v = BLOCK_DEFAULTS.video();
    expect(v.autoplay).toBe(true);
    expect(v.loop).toBe(true);
    expect(v.muted).toBe(true);
    expect(v.controls).toBe(false);
  });

  test("edge to edge, like the hero above it", () => {
    expect(BLOCK_DEFAULTS.video().full_width).toBe(true);
  });

  test("landscape on a wide screen, portrait on a tall one", () => {
    const v = BLOCK_DEFAULTS.video();
    expect(v.aspect).toBe("16:9");
    expect(v.aspect_mobile).toBe("9:16");
  });
});

describe("the container's shape", () => {
  test("uses the desktop ratio on a wide screen", () => {
    const c = draw({ file_url: "/a.mp4", aspect: "16:9", aspect_mobile: "9:16" });
    expect([...box(c).classList]).toContain("aspect-video");
  });

  test("switches to the mobile ratio below the breakpoint", () => {
    const c = draw({ file_url: "/a.mp4", aspect: "16:9", aspect_mobile: "9:16" });
    setMobile(true);
    expect([...box(c).classList]).toContain("aspect-[9/16]");
  });

  test("a block with no mobile ratio keeps the desktop one", () => {
    // Absent means legacy. Every video block published before this had one ratio at every
    // size, and must go on looking exactly as it did.
    const c = draw({ file_url: "/a.mp4", aspect: "4:3", aspect_mobile: undefined });
    setMobile(true);
    expect([...box(c).classList]).toContain("aspect-[4/3]");
  });

  test("no hairline border when it bleeds", () => {
    // A border around a full-bleed video is a line down the side of the screen.
    const full = draw({ file_url: "/a.mp4", full_width: true });
    expect([...box(full).classList]).not.toContain("border");
  });

  test("but a framed one keeps its border", () => {
    const framed = draw({ file_url: "/a.mp4", full_width: false });
    expect([...box(framed).classList]).toContain("border");
  });
});

describe("the mobile cut", () => {
  test("is used below the breakpoint when there is one", () => {
    draw({ file_url: "/wide.mp4", file_url_mobile: "/tall.mp4" });
    expect(screen.getByTestId("video-file").getAttribute("src")).toContain("/wide.mp4");
    setMobile(true);
    expect(screen.getByTestId("video-file").getAttribute("src")).toContain("/tall.mp4");
  });

  test("only one file is ever in the document", () => {
    // The reason the source is swapped in JS rather than with two CSS-hidden elements: a
    // hidden <video> still downloads its source, so the CSS approach would pull BOTH cuts
    // on every visit — which on a pair of 100MB files defeats having two of them.
    const c = draw({ file_url: "/wide.mp4", file_url_mobile: "/tall.mp4" });
    expect(c.querySelectorAll("video")).toHaveLength(1);
    setMobile(true);
    expect(c.querySelectorAll("video")).toHaveLength(1);
  });

  test("falls back to the desktop file when no mobile cut was uploaded", () => {
    draw({ file_url: "/only.mp4", file_url_mobile: "" });
    setMobile(true);
    expect(screen.getByTestId("video-file").getAttribute("src")).toContain("/only.mp4");
  });

  test("the mobile poster is used with the mobile cut", () => {
    draw({ file_url: "/w.mp4", poster_url: "/w.jpg",
           file_url_mobile: "/t.mp4", poster_url_mobile: "/t.jpg" });
    setMobile(true);
    expect(screen.getByTestId("video-file").getAttribute("poster")).toContain("/t.jpg");
  });

  test("a mobile cut with no poster of its own falls back to the desktop poster", () => {
    draw({ file_url: "/w.mp4", poster_url: "/w.jpg", file_url_mobile: "/t.mp4" });
    setMobile(true);
    expect(screen.getByTestId("video-file").getAttribute("poster")).toContain("/w.jpg");
  });
});
