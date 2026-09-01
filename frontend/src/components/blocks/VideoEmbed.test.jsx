/**
 * The video block, rendered (audit M11).
 *
 * `embeds.test.js` covers which URLs resolve; this covers what the DOM ends up
 * containing — the two can disagree, and the DOM is what an attacker gets.
 *
 * `react-router-dom` is mocked virtually: its v7 ESM entry point is unresolvable by the
 * jest that ships with react-scripts 5, and it is nothing to do with what is under test
 * here. Same for the API client and the toast library, which this block imports for its
 * *other* renderers.
 */
import { render, screen } from "@testing-library/react";

vi.mock("react-router-dom", () => ({ Link: ({ children }) => <a href="/">{children}</a> }));
vi.mock("../../api", () => ({ http: { get: vi.fn(), post: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { BlockRenderer } from "./index";

const videoBlock = (url) => ({ block_id: "b1", type: "video", props: { url, caption: "A film" } });

const iframeIn = (container) => container.querySelector("iframe");

describe("a URL that is not an allowlisted embed", () => {
  const HOSTILE = "https://evil.example/login";

  test("renders no iframe at all on the public site", () => {
    const { container } = render(<BlockRenderer block={videoBlock(HOSTILE)} />);
    expect(iframeIn(container)).toBeNull();
    expect(container.innerHTML).not.toContain("evil.example");
  });

  test("renders nothing visible on the public site, rather than a broken notice", () => {
    const { container } = render(<BlockRenderer block={videoBlock(HOSTILE)} />);
    expect(container.querySelector('[data-testid="video-unsupported"]')).toBeNull();
  });

  test("but tells the editor, in the preview, where it can be fixed", () => {
    render(<BlockRenderer block={videoBlock(HOSTILE)} preview />);
    expect(screen.getByTestId("video-unsupported")).toBeVisible();
    expect(screen.getByText(HOSTILE)).toBeVisible();
  });

  test("still renders no iframe in the preview", () => {
    const { container } = render(<BlockRenderer block={videoBlock(HOSTILE)} preview />);
    expect(iframeIn(container)).toBeNull();
  });
});

describe("an allowlisted embed", () => {
  test("frames the canonical URL, not the pasted one", () => {
    const { container } = render(
      <BlockRenderer block={videoBlock("https://youtu.be/dQw4w9WgXcQ")} />);
    expect(iframeIn(container)).toHaveAttribute(
      "src", "https://www.youtube.com/embed/dQw4w9WgXcQ");
  });

  test("carries a sandbox, and never allow-top-navigation", () => {
    // frame-src in the CSP says who may be framed; sandbox says what they may then do.
    // top-navigation is the one that would let an embed move the visitor off the page.
    const { container } = render(
      <BlockRenderer block={videoBlock("https://vimeo.com/123456789")} />);
    const sandbox = iframeIn(container).getAttribute("sandbox");
    expect(sandbox).toBeTruthy();
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(sandbox).not.toContain("allow-forms");
  });

  test("keeps the caption", () => {
    render(<BlockRenderer block={videoBlock("https://vimeo.com/123456789")} />);
    expect(screen.getByText("A film")).toBeVisible();
  });

  test("an empty url renders nothing in either mode", () => {
    const { container: pub } = render(<BlockRenderer block={videoBlock("")} />);
    expect(pub.innerHTML).toBe("");
    const { container: prev } = render(<BlockRenderer block={videoBlock("")} preview />);
    expect(prev.innerHTML).toBe("");
  });
});

describe("autoplay", () => {
  const block = (props) => ({ block_id: "b1", type: "video", props });

  test("an embed with autoplay off keeps a bare canonical src", () => {
    const { container } = render(
      <BlockRenderer block={block({ url: "https://youtu.be/dQw4w9WgXcQ" })} />);
    expect(iframeIn(container)).toHaveAttribute("src", "https://www.youtube.com/embed/dQw4w9WgXcQ");
  });

  test("an embed with autoplay on asks for it in the src and in allow=", () => {
    const { container } = render(
      <BlockRenderer block={block({ url: "https://youtu.be/dQw4w9WgXcQ", autoplay: true })} />);
    const frame = iframeIn(container);
    expect(new URL(frame.getAttribute("src")).searchParams.get("autoplay")).toBe("1");
    // The src alone is not enough: without `autoplay` in the iframe's permissions policy
    // the player is not allowed to start itself.
    expect(frame.getAttribute("allow")).toContain("autoplay");
  });

  test("an uploaded file renders a <video>, not a frame", () => {
    const { container } = render(
      <BlockRenderer block={block({ file_url: "/uploads/a.mp4", autoplay: true, loop: true })} />);
    expect(iframeIn(container)).toBeNull();
    const video = container.querySelector("video");
    expect(video).toBeTruthy();
    expect(video.autoplay).toBe(true);
    expect(video.loop).toBe(true);
    // Autoplay is only ever granted to a muted element, so the block does not offer the
    // combination that would silently never play.
    expect(video.muted).toBe(true);
  });

  test("an uploaded file wins over an embed URL when an author has set both", () => {
    const { container } = render(
      <BlockRenderer block={block({ url: "https://youtu.be/dQw4w9WgXcQ", file_url: "/uploads/a.mp4" })} />);
    expect(iframeIn(container)).toBeNull();
    expect(container.querySelector("video")).toBeTruthy();
  });

  test("a file without autoplay is not muted by force and keeps its controls", () => {
    const { container } = render(
      <BlockRenderer block={block({ file_url: "/uploads/a.mp4", muted: false })} />);
    const video = container.querySelector("video");
    expect(video.muted).toBe(false);
    expect(video.controls).toBe(true);
  });

  test("a hostile file_url is still just a media load, never a frame", () => {
    const { container } = render(
      <BlockRenderer block={block({ file_url: "https://evil.example/login" })} />);
    expect(iframeIn(container)).toBeNull();
  });
});

/**
 * How an audio player is sized.
 *
 * A video is a rectangle and gets an aspect ratio. A SoundCloud or Bandcamp player is a
 * control strip, so it gets a height instead — and a playlist is not a track. The compact
 * 166px player is right for one track and cuts a playlist off at its first row, which is
 * the row nobody embedded a playlist to see.
 */
const audioBlock = (url, extra = {}) =>
  ({ block_id: "b2", type: "video", props: { url, ...extra } });

const frameHeight = (container) => container.querySelector("iframe")?.parentElement?.style.height;

describe("audio players are sized by height, not aspect", () => {
  test("a single track gets the compact player", () => {
    const { container } = render(
      <BlockRenderer block={audioBlock("https://soundcloud.com/artist/a-track")} />);
    expect(frameHeight(container)).toBe("166px");
  });

  test("a playlist gets room for its track list", () => {
    const { container } = render(
      <BlockRenderer block={audioBlock("https://soundcloud.com/artist/sets/a-playlist")} />);
    expect(frameHeight(container)).toBe("400px");
  });

  test("SoundCloud's own embed code lands as a playlist", () => {
    const { container } = render(<BlockRenderer block={audioBlock(
      "https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/playlists/"
      + "soundcloud%253Aplaylists%253A1084330825&visual=true")} />);
    expect(container.querySelector("iframe")).toBeTruthy();
    expect(frameHeight(container)).toBe("400px");
  });

  test("a block can name its own height", () => {
    const { container } = render(<BlockRenderer block={audioBlock(
      "https://soundcloud.com/artist/a-track", { embed_height: 320 })} />);
    expect(frameHeight(container)).toBe("320px");
  });

  test("that height is clamped, not trusted", () => {
    const tall = render(<BlockRenderer block={audioBlock(
      "https://soundcloud.com/artist/a-track", { embed_height: 99999 })} />);
    expect(frameHeight(tall.container)).toBe("1000px");
    const short = render(<BlockRenderer block={audioBlock(
      "https://soundcloud.com/artist/a-track", { embed_height: 1 })} />);
    expect(frameHeight(short.container)).toBe("80px");
  });

  test("junk falls back to the default rather than reaching the DOM", () => {
    for (const bad of ["", null, "abc"]) {
      const { container } = render(<BlockRenderer block={audioBlock(
        "https://soundcloud.com/artist/a-track", { embed_height: bad })} />);
      expect(frameHeight(container)).toBe("166px");
    }
  });

  test("a video keeps its aspect ratio and gets no height", () => {
    const { container } = render(
      <BlockRenderer block={audioBlock("https://www.youtube.com/watch?v=abcdefghijk")} />);
    expect(frameHeight(container)).toBeFalsy();
    expect(container.querySelector(".aspect-video")).toBeTruthy();
  });
});
