/**
 * The Split family and the clip player.
 *
 * Three things are being asserted, and they pull in different directions:
 *
 *   THE NEW CONTROLS DO SOMETHING — alignment, heading size, the width ratio, the height
 *   cap. A control that renders and changes nothing is the failure mode this codebase has
 *   hit before (the hero's overlay boolean), so each one is checked against the markup it
 *   is supposed to move.
 *
 *   NOTHING ALREADY PUBLISHED MOVES. These fields were added to a block that is live, so
 *   "absent" has to keep meaning what it meant: 30px and 48px, uppercase, a square.
 *
 *   THE PLAYER PLAYS ONE THING AT A TIME, steps to the next when one ends, and stops at
 *   ninety seconds. jsdom has no media stack, so the element's own methods are stubbed and
 *   the events it would fire are fired by hand.
 */
import { act, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BlockRenderer, AUDIO_TRACK_MAX_SECONDS } from "./index";
import { BLOCK_DEFAULTS } from "../../lib/cms";

const draw = (type, props) =>
  render(
    <MemoryRouter>
      <BlockRenderer block={{ block_id: "b1", type, enabled: true, props }} />
    </MemoryRouter>
  ).container;

/** A block created the way the editor creates one, with only the named props changed. */
const fresh = (type, over) => draw(type, { ...BLOCK_DEFAULTS[type](), ...over });

describe("split: text placement", () => {
  const box = (over) => draw("split", { heading: "Hi", ...over }).querySelector('[data-testid="split-text"]');

  test("vertical placement is top, middle or bottom", () => {
    expect(box({ content_y: "top" }).className).toContain("justify-start");
    expect(box({ content_y: "middle" }).className).toContain("justify-center");
    expect(box({ content_y: "bottom" }).className).toContain("justify-end");
  });

  test("the text column is full height, or there is nothing to place it within", () => {
    // Without this the column is exactly as tall as its words and all three positions
    // render identically.
    expect(box({}).className).toContain("h-full");
  });

  test("horizontal alignment moves the block as well as the lines", () => {
    // items-* as well as text-*: inside a flex column the button is stretched by default,
    // so a centred column with only text-center would still have a hard-left button.
    expect(box({ align: "center" }).className).toContain("text-center");
    expect(box({ align: "center" }).className).toContain("items-center");
    expect(box({ align: "right" }).className).toContain("items-end");
  });

  test("absent means left, which is where these have always sat", () => {
    expect(box({}).className).toContain("text-left");
  });
});

describe("split: heading size", () => {
  const heading = (over) => draw("split", { heading: "Hi", ...over }).querySelector('[data-testid="split-heading"]');
  const px = (el, key) => el.style.getPropertyValue(`--hero-heading-${key}`);

  test("a block with no size set renders at the size it always did", () => {
    // text-3xl / md:text-5xl, which is 30px and 48px. The hero's own fallback is 48/72 —
    // borrowing it here would have quietly enlarged every split already published.
    const h = heading({});
    expect(px(h, "mobile")).toBe("30px");
    expect(px(h, "desktop")).toBe("48px");
  });

  test("both breakpoints are set separately", () => {
    const h = heading({ heading_size_mobile: 22, heading_size_desktop: 96 });
    expect(px(h, "mobile")).toBe("22px");
    expect(px(h, "desktop")).toBe("96px");
  });

  test("a size out of range is clamped rather than honoured", () => {
    expect(px(heading({ heading_size_desktop: 4000 }), "desktop")).toBe("240px");
    expect(px(heading({ heading_size_mobile: 2 }), "mobile")).toBe("16px");
  });

  test("casing follows the field, and absent still shouts", () => {
    expect(heading({}).className).toContain("uppercase");
    expect(heading({ text_case: "as-typed" }).className).toContain("normal-case");
  });
});

describe("split: the element takes the photograph's height", () => {
  const media = (over) => draw("split", { image_url: "/p.jpg", ...over }).querySelector('[data-testid="split-media"]');

  test("a named ratio still crops to that ratio, as published blocks do", () => {
    expect(media({ aspect: "16:9" }).className).toContain("aspect-video");
    expect(media({ aspect: "16:9" }).querySelector("img").className).toContain("object-cover");
  });

  test("a block saved before this existed is still a square", () => {
    // The renderer's fallback, not the factory's: an old block has no aspect at all.
    expect(media({}).className).toContain("aspect-square");
  });

  test("natural drops the forced ratio and lets the image set the height", () => {
    const el = media({ aspect: "natural" });
    expect(el.className).not.toMatch(/aspect-/);
    expect(el.querySelector("img").className).toContain("h-auto");
  });

  test("a new block is natural, and the row stretches to whatever that is", () => {
    const c = fresh("split", { image_url: "/p.jpg" });
    expect(c.querySelector('[data-testid="split-media"]').className).not.toMatch(/aspect-/);
    expect(c.querySelector(".grid").className).toContain("items-stretch");
  });
});

describe("split + audio: proportions", () => {
  const grid = (over) => draw("split_audio", { image_url: "/p.jpg", ...over }).querySelector('[data-testid="split-audio"]');

  test("the ratio sets the two column tracks", () => {
    const el = grid({ ratio: 70 });
    expect(el.style.getPropertyValue("--column-ratio-a")).toBe("70fr");
    expect(el.style.getPropertyValue("--column-ratio-b")).toBe("30fr");
  });

  test("reversing swaps the tracks too, so the photograph keeps its share", () => {
    // Order alone would move the image into the column sized for the text.
    const el = grid({ ratio: 70, direction: "image-right" });
    expect(el.style.getPropertyValue("--column-ratio-a")).toBe("30fr");
    expect(el.style.getPropertyValue("--column-ratio-b")).toBe("70fr");
  });

  test("at fifty the two halves meet in the middle", () => {
    const el = grid({ ratio: 50, direction: "image-right" });
    expect(el.style.getPropertyValue("--column-ratio-a")).toBe("50fr");
    expect(el.style.getPropertyValue("--column-ratio-b")).toBe("50fr");
  });

  test("the columns are not written inline, or a phone would get two thin ones", () => {
    // The value is a variable and `.column-ratio` applies it from `md` up. An inline
    // grid-template-columns would beat the breakpoint and never stack.
    const el = grid({ ratio: 60 });
    expect(el.style.gridTemplateColumns).toBe("");
    expect(el.className).toContain("column-ratio");
  });

  test("a ratio outside the slider's range is pulled back into it", () => {
    expect(grid({ ratio: 500 }).getAttribute("data-ratio")).toBe("80");
    expect(grid({ ratio: 0 }).getAttribute("data-ratio")).toBe("20");
    expect(grid({ ratio: "nonsense" }).getAttribute("data-ratio")).toBe("50");
  });
});

describe("split + audio: the photograph", () => {
  const image = (over) => draw("split_audio", { image_url: "/p.jpg", ...over }).querySelector('[data-testid="split-audio-image"]');

  test("it keeps its own proportions and caps at the set height", () => {
    const img = image({ max_height: 500 });
    expect(img.className).toContain("h-auto");
    expect(img.style.maxHeight).toBe("500px");
  });

  test("past the cap it crops rather than squashes", () => {
    expect(image({}).className).toContain("object-cover");
  });

  test("no hairline around it", () => {
    // Asked for by name. Split draws one; this block does not.
    const media = draw("split_audio", { image_url: "/p.jpg" }).querySelector('[data-testid="split-audio-media"]');
    expect(media.className).not.toContain("border");
    expect(image({}).className).not.toContain("border");
  });

  test("a height that is not a number falls back rather than vanishing", () => {
    expect(image({ max_height: "" }).style.maxHeight).toBe("640px");
  });
});

describe("split + audio: the words", () => {
  test("a second call to action sits beside the first", () => {
    const c = draw("split_audio", {
      heading: "Hi", cta_label: "Tickets", cta_href: "/events",
      second_cta_label: "Read more", second_cta_href: "/mission",
    });
    expect(c.querySelector('[data-testid="split-audio-cta"]').getAttribute("href")).toBe("/events");
    const second = c.querySelector('[data-testid="split-audio-cta-2"]');
    expect(second.textContent).toBe("Read more");
    expect(second.getAttribute("href")).toBe("/mission");
  });

  test("the text is placed within the height the photograph set", () => {
    const box = draw("split_audio", { heading: "Hi", content_y: "bottom" })
      .querySelector('[data-testid="split-audio-text"]');
    expect(box.className).toContain("justify-end");
    expect(box.className).toContain("flex-1");
  });
});

describe("the clip player", () => {
  const TRACKS = [
    { title: "One", url: "/a.mp3" },
    { title: "Two", url: "/b.mp3" },
  ];
  const withTracks = (over) => draw("split_audio", { heading: "Hi", tracks: TRACKS, ...over });

  let played;
  let paused;
  beforeEach(() => {
    played = 0;
    paused = 0;
    // jsdom implements neither, and calling them unstubbed logs a "not implemented"
    // error per press. The block guards against that; these count the calls instead.
    HTMLMediaElement.prototype.play = function play() { played += 1; return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function pause() { paused += 1; };
  });

  const press = (c, i) => fireEvent.click(c.querySelector(`[data-testid="audio-track-${i}"]`));
  const playing = (c, i) => c.querySelector(`[data-testid="audio-track-${i}"]`).getAttribute("aria-pressed") === "true";

  test("nothing is drawn when there are no clips", () => {
    expect(withTracks({ tracks: [] }).querySelector('[data-testid="audio-playlist"]')).toBeNull();
  });

  test("a row without a file is not a row", () => {
    const c = withTracks({ tracks: [{ title: "One", url: "/a.mp3" }, { title: "Empty", url: "" }] });
    expect(c.querySelectorAll("[data-testid^='audio-track-']").length).toBe(1);
  });

  test("pressing a row plays it", () => {
    const c = withTracks({});
    press(c, 0);
    expect(playing(c, 0)).toBe(true);
    expect(played).toBe(1);
  });

  test("pressing the same row again pauses it", () => {
    const c = withTracks({});
    press(c, 0);
    press(c, 0);
    expect(playing(c, 0)).toBe(false);
    expect(paused).toBeGreaterThan(0);
  });

  test("pressing another row switches to it — one player, so the first stops", () => {
    const c = withTracks({});
    press(c, 0);
    press(c, 1);
    expect(playing(c, 0)).toBe(false);
    expect(playing(c, 1)).toBe(true);
  });

  test("the end of a clip starts the next one", () => {
    const c = withTracks({});
    press(c, 0);
    fireEvent.ended(c.querySelector('[data-testid="audio-element"]'));
    expect(playing(c, 1)).toBe(true);
  });

  test("the end of the last clip stops, rather than looping back", () => {
    const c = withTracks({});
    press(c, 1);
    fireEvent.ended(c.querySelector('[data-testid="audio-element"]'));
    expect(playing(c, 0)).toBe(false);
    expect(playing(c, 1)).toBe(false);
  });

  test("a clip longer than the cap is cut off at it and the next one starts", () => {
    const c = withTracks({});
    press(c, 0);
    const el = c.querySelector('[data-testid="audio-element"]');
    act(() => {
      Object.defineProperty(el, "currentTime", { value: AUDIO_TRACK_MAX_SECONDS + 0.5, configurable: true });
      fireEvent.timeUpdate(el);
    });
    expect(playing(c, 0)).toBe(false);
    expect(playing(c, 1)).toBe(true);
  });

  test("starting a second player on the page silences the first", () => {
    // One <audio> per block keeps a block from playing over itself; it does nothing about
    // a page carrying two blocks, which sounded both at once until the module-level
    // handover. Caught in a real browser, pinned here.
    const c = render(
      <MemoryRouter>
        <BlockRenderer block={{ block_id: "a", type: "split_audio", enabled: true,
                                props: { heading: "A", tracks: TRACKS } }} />
        <BlockRenderer block={{ block_id: "b", type: "split_audio", enabled: true,
                                props: { heading: "B", tracks: TRACKS } }} />
      </MemoryRouter>
    ).container;
    const [first, second] = c.querySelectorAll('[data-testid="audio-playlist"]');
    const pressed = (el, i) => el.querySelector(`[data-testid="audio-track-${i}"]`).getAttribute("aria-pressed") === "true";

    fireEvent.click(first.querySelector('[data-testid="audio-track-0"]'));
    expect(pressed(first, 0)).toBe(true);

    fireEvent.click(second.querySelector('[data-testid="audio-track-0"]'));
    expect(pressed(second, 0)).toBe(true);
    expect(pressed(first, 0)).toBe(false);
  });

  test("a row with no name of its own still has one", () => {
    const c = withTracks({ tracks: [{ url: "/a.mp3" }] });
    expect(c.querySelector('[data-testid="audio-track-0"]').textContent).toContain("Track 1");
  });
});
