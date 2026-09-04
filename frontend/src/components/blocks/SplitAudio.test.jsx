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

describe("closing the gap, for a chessboard", () => {
  /* Two split blocks stacked with opposite directions tile like a chessboard only if the
     photographs reach the column boundary. At the old fixed 40px there is a permanent band
     down the middle and the corners never meet. */
  const grid = (type, over) =>
    draw(type, { image_url: "/p.jpg", heading: "Hi", ...over })
      .querySelector(`[data-testid="${type === "split" ? "split" : "split-audio"}"]`);
  const textBox = (type, over) =>
    draw(type, { image_url: "/p.jpg", heading: "Hi", ...over })
      .querySelector(`[data-testid="${type === "split" ? "split-text" : "split-audio-text"}"]`);

  test.each(["split", "split_audio"])("%s: the gap is a value, and zero is one of them", (type) => {
    expect(grid(type, { gap: 0 }).style.columnGap).toBe("0px");
    expect(grid(type, { gap: 64 }).style.columnGap).toBe("64px");
  });

  test.each(["split", "split_audio"])("%s: a block that never set one keeps the old 40px", (type) => {
    expect(grid(type, {}).style.columnGap).toBe("40px");
  });

  test.each(["split", "split_audio"])("%s: closing it does not stack the words on the photo", (type) => {
    // Below md the two columns become one on top of the other, and a zero COLUMN gap must
    // not take the row gap with it — the words would sit against the bottom of the picture.
    expect(grid(type, { gap: 0 }).style.rowGap).toBe("2.5rem");
  });

  test.each(["split", "split_audio"])("%s: what the gap gives up, the text takes as padding", (type) => {
    // The point of the pair: the tiles touch, the words keep their distance.
    expect(textBox(type, { gap: 0 }).style.getPropertyValue("--column-pad")).toBe("40px");
    expect(textBox(type, { gap: 15 }).style.getPropertyValue("--column-pad")).toBe("25px");
    expect(textBox(type, { gap: 40 }).style.getPropertyValue("--column-pad")).toBe("0px");
    // A gap wider than the breathing room needs no help, and must not go negative.
    expect(textBox(type, { gap: 80 }).style.getPropertyValue("--column-pad")).toBe("0px");
  });

  test.each(["split", "split_audio"])("%s: only the side facing the photograph is padded", (type) => {
    // Padding the outer edge would pull the text off the margin every other block on the
    // page lines up with.
    expect(textBox(type, { gap: 0, direction: "image-left" }).className).toContain("column-pad-start");
    expect(textBox(type, { gap: 0, direction: "image-right" }).className).toContain("column-pad-end");
  });

  test.each(["split", "split_audio"])("%s: the padding is a variable, so a phone is not indented", (type) => {
    // `.column-pad-*` only applies it from md up. Inline padding would indent the text on
    // a stacked phone layout, where there is no photograph beside it to move away from.
    const el = textBox(type, { gap: 0 });
    expect(el.style.paddingLeft).toBe("");
    expect(el.style.paddingRight).toBe("");
  });

  test("a gap outside the slider is pulled back into it", () => {
    expect(grid("split", { gap: -20 }).style.columnGap).toBe("0px");
    expect(grid("split", { gap: 500 }).style.columnGap).toBe("80px");
    expect(grid("split", { gap: "" }).style.columnGap).toBe("40px");
  });

  test("split's hairline can be dropped, which is the last of the gap", () => {
    // Measured before this existed: with the gap at 0 the CELLS met exactly, but a 1px
    // border on each photograph left a 2px seam between tiles in both directions.
    const media = (over) => draw("split", { image_url: "/p.jpg", ...over })
      .querySelector('[data-testid="split-media"]');
    expect(media({}).className).toContain("border");
    expect(media({ hairline: true }).className).toContain("border");
    expect(media({ hairline: false }).className).not.toContain("border");
  });

  test("a block that predates the toggle still draws its hairline", () => {
    const c = draw("split", { image_url: "/p.jpg" });
    expect(c.querySelector('[data-testid="split-media"]').className).toContain("border-ink/10");
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

describe("split + audio: the join between the two", () => {
  const block = (over) => draw("split_audio", { image_url: "/p.jpg", heading: "Hi", center_seam: true, ...over });
  const grid = (over) => block(over).querySelector('[data-testid="split-audio"]');
  const media = (over) => block(over).querySelector('[data-testid="split-audio-media"]');
  const column = (over) => block(over).querySelector('[data-testid="split-audio-column"]');
  const shareOf = (el) => el.style.getPropertyValue("--seam-share");

  test("centred, the two tracks are equal halves whatever the ratio says", () => {
    // This is the whole mechanism: the ratio stops sizing the tracks, so the join cannot
    // move off the middle, and starts sizing what each side fills within its half.
    const el = grid({ ratio: 70 });
    expect(el.style.getPropertyValue("--column-ratio-a")).toBe("50fr");
    expect(el.style.getPropertyValue("--column-ratio-b")).toBe("50fr");
  });

  test("the larger side fills its half and the smaller gives width to the outer edge", () => {
    expect(shareOf(media({ ratio: 70 }))).toBe("100%");
    // 30/70 of a half, not 30% of the block — the shortfall is margin beyond the text.
    expect(shareOf(column({ ratio: 70 }))).toBe(`${(30 / 70) * 100}%`);
  });

  test("it works the other way round too", () => {
    expect(shareOf(column({ ratio: 30 }))).toBe("100%");
    expect(shareOf(media({ ratio: 30 }))).toBe(`${(30 / 70) * 100}%`);
  });

  test("at fifty both sides fill their halves, which is edge to edge", () => {
    expect(shareOf(media({ ratio: 50 }))).toBe("100%");
    expect(shareOf(column({ ratio: 50 }))).toBe("100%");
  });

  test("the element in the left half is pushed across to meet the join", () => {
    // The one in the right half already starts there, so only the left gets the margin.
    expect(media({ ratio: 70 }).className).toContain("seam-share-end");
    expect(column({ ratio: 70 }).className).not.toContain("seam-share-end");
  });

  test("reversing moves the margin to whichever element is now on the left", () => {
    expect(media({ ratio: 70, direction: "image-right" }).className).not.toContain("seam-share-end");
    expect(column({ ratio: 70, direction: "image-right" }).className).toContain("seam-share-end");
  });

  test("the share is a variable, so a phone gets a full-width element and not 43% of one", () => {
    // `.seam-share` only applies the variable from `md` up. An inline width would leave a
    // stacked phone layout showing a photograph two fifths of the way across the screen.
    const el = media({ ratio: 70 });
    expect(el.style.width).toBe("");
    expect(el.className).toContain("seam-share");
  });

  test("off, the ratio sizes the tracks and nothing is shared", () => {
    const el = grid({ center_seam: false, ratio: 70 });
    expect(el.style.getPropertyValue("--column-ratio-a")).toBe("70fr");
    expect(media({ center_seam: false, ratio: 70 }).className).not.toContain("seam-share");
  });

  test("a block saved before the control existed keeps the layout it had", () => {
    const el = grid({ center_seam: undefined, ratio: 70 });
    expect(el.getAttribute("data-centred")).toBe("false");
    expect(el.style.getPropertyValue("--column-ratio-a")).toBe("70fr");
  });

  test("the text keeps its indentation from the join and from the screen edge", () => {
    // The gap is what the words are indented BY; the inset is what keeps them off the
    // glass at full width. Neither survives on its own if the column wrapper swallows it.
    const c = draw("split_audio", { image_url: "/p.jpg", heading: "Hi", center_seam: true, full_width: true });
    // The gap became a value rather than a class when it was made adjustable; the default
    // is still the 40px `gap-10` drew, and the assertion is about the distance, not the
    // mechanism.
    expect(c.querySelector('[data-testid="split-audio"]').style.columnGap).toBe("40px");
    expect(c.querySelector("h2").closest(".edge-inset")).toBeTruthy();
  });

  test("the column still has a height to place its text within", () => {
    // The share wrapper became the grid child, so the inset below it needs h-full handed
    // down — without it the inner column collapses to the height of its own words and
    // top/middle/bottom stop meaning anything.
    const c = block({ ratio: 70 });
    expect(c.querySelector(".edge-inset, [class*='h-full']")).toBeTruthy();
    expect(c.querySelector('[data-testid="split-audio-text"]').parentElement.className).toContain("h-full");
  });
});

describe("split + audio: ratio bounds", () => {
  const grid = (over) => draw("split_audio", { image_url: "/p.jpg", ...over }).querySelector('[data-testid="split-audio"]');

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

  test("the transport drives the same player the rows do", () => {
    const c = withTracks({});
    const playpause = c.querySelector('[data-testid="audio-playpause"]');
    fireEvent.click(playpause);
    expect(playing(c, 0)).toBe(true);
    expect(playpause.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(playpause);
    expect(playing(c, 0)).toBe(false);
  });

  test("pausing keeps the track loaded instead of rewinding it", () => {
    // The reason which-track and whether-it-is-playing are separate state. Combined, pause
    // had to mean "nothing selected", so the controls pointed at nothing and resuming
    // started the clip again from zero.
    const c = withTracks({});
    press(c, 1);
    fireEvent.click(c.querySelector('[data-testid="audio-playpause"]'));   // pause
    expect(c.querySelector('[data-testid="audio-now-playing"]').textContent).toBe("Two");
    fireEvent.click(c.querySelector('[data-testid="audio-playpause"]'));   // resume
    expect(playing(c, 1)).toBe(true);
  });

  test("previous and next step through the list", () => {
    const c = withTracks({});
    fireEvent.click(c.querySelector('[data-testid="audio-next"]'));
    expect(c.querySelector('[data-testid="audio-now-playing"]').textContent).toBe("Two");
    fireEvent.click(c.querySelector('[data-testid="audio-prev"]'));
    expect(c.querySelector('[data-testid="audio-now-playing"]').textContent).toBe("One");
  });

  test("they stop at the ends rather than wrapping", () => {
    const c = withTracks({});
    expect(c.querySelector('[data-testid="audio-prev"]')).toBeDisabled();
    fireEvent.click(c.querySelector('[data-testid="audio-next"]'));
    expect(c.querySelector('[data-testid="audio-next"]')).toBeDisabled();
  });

  test("the scrubber seeks the audio, not just the readout", () => {
    const c = withTracks({});
    press(c, 0);
    const el = c.querySelector('[data-testid="audio-element"]');
    fireEvent.change(c.querySelector('[data-testid="audio-seek"]'), { target: { value: "12" } });
    expect(el.currentTime).toBe(12);
    expect(c.querySelector('[data-testid="audio-elapsed"]').textContent).toBe("0:12");
  });

  test("it cannot be dragged past the point the clip will stop at", () => {
    // A control that let you seek to 1:40 of something that stops at 1:30 would be lying
    // about what it is going to play.
    const c = withTracks({});
    expect(c.querySelector('[data-testid="audio-seek"]').getAttribute("max"))
      .toBe(String(AUDIO_TRACK_MAX_SECONDS));
    expect(c.querySelector('[data-testid="audio-duration"]').textContent).toBe("1:30");
  });

  test("mute and volume reach the element", () => {
    const c = withTracks({});
    const el = c.querySelector('[data-testid="audio-element"]');
    fireEvent.change(c.querySelector('[data-testid="audio-volume"]'), { target: { value: "0.4" } });
    expect(el.volume).toBeCloseTo(0.4);
    fireEvent.click(c.querySelector('[data-testid="audio-mute"]'));
    expect(el.muted).toBe(true);
    fireEvent.click(c.querySelector('[data-testid="audio-mute"]'));
    expect(el.muted).toBe(false);
  });

  test("every control says what it is, for anyone not using a mouse", () => {
    const c = withTracks({});
    for (const id of ["audio-prev", "audio-playpause", "audio-next", "audio-seek", "audio-mute", "audio-volume"]) {
      expect(c.querySelector(`[data-testid="${id}"]`).getAttribute("aria-label")).toBeTruthy();
    }
  });

  test("every row prints its length, from the block's own data", () => {
    // The reference player lists them the same way. Read from what the CMS measured, so a
    // list of six costs six requests to nobody — `preload="none"` is still the rule.
    const c = draw("split_audio", { heading: "Hi", tracks: [
      { title: "One", url: "/a.mp3", duration: 62 },
      { title: "Two", url: "/b.mp3", duration: 9 },
    ] });
    expect(c.querySelector('[data-testid="audio-length-0"]').textContent).toBe("1:02");
    expect(c.querySelector('[data-testid="audio-length-1"]').textContent).toBe("0:09");
  });

  test("a row prints what will play, not what the file holds", () => {
    // The transport reads 1:30 for anything over the cap; a row claiming 5:29 beside it
    // would be the one that is wrong.
    const c = draw("split_audio", { heading: "Hi", tracks: [{ title: "Long", url: "/a.mp3", duration: 329 }] });
    expect(c.querySelector('[data-testid="audio-length-0"]').textContent).toBe("1:30");
  });

  test("a track nobody measured shows nothing rather than a dash", () => {
    // Pasted rather than uploaded, or saved before the field existed. An honest blank
    // beats "--:--" against every row.
    const c = draw("split_audio", { heading: "Hi", tracks: [{ title: "One", url: "/a.mp3" }] });
    expect(c.querySelector('[data-testid="audio-length-0"]').textContent).toBe("");
  });

  test("what the element reports beats what was stored", () => {
    // A file replaced at the same URL would otherwise print the old length until someone
    // re-opened the block in the CMS.
    const c = draw("split_audio", { heading: "Hi", tracks: [{ title: "One", url: "/a.mp3", duration: 60 }] });
    const el = c.querySelector('[data-testid="audio-element"]');
    fireEvent.click(c.querySelector('[data-testid="audio-track-0"]'));
    Object.defineProperty(el, "duration", { value: 25, configurable: true });
    fireEvent.loadedMetadata(el);
    expect(c.querySelector('[data-testid="audio-length-0"]').textContent).toBe("0:25");
  });

  test("the length is not counted as a row", () => {
    // It sits inside the row button and the rows are found by a testid PREFIX match, so a
    // child named `audio-track-N-length` doubled the count. Caught by an existing test.
    const c = withTracks({});
    expect(c.querySelectorAll("[data-testid^='audio-track-']").length).toBe(2);
  });

  test("a row with no name of its own still has one", () => {
    const c = withTracks({ tracks: [{ url: "/a.mp3" }] });
    expect(c.querySelector('[data-testid="audio-track-0"]').textContent).toContain("Track 1");
  });
});
