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
import React from "react";
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
