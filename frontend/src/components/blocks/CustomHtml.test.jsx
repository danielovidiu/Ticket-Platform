/**
 * The custom_html block, after its sanitizer became a dynamic import.
 *
 * DOMPurify was 122 kB in the entry chunk serving every page of every deployment, for a
 * block type most pages do not contain. Splitting it out introduced something that did
 * not exist before: a window in which the component holds the author's raw HTML and does
 * not yet hold the thing that cleans it.
 *
 * These tests are about that window. The block renders nothing until the sanitizer has
 * run — not the raw string, not a placeholder built from it — and the same is true when
 * the chunk never arrives at all.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BlockRenderer } from "./index";

const draw = (html) =>
  render(
    <MemoryRouter>
      <BlockRenderer block={{ block_id: "b1", type: "custom_html", props: { html } }} />
    </MemoryRouter>,
  );

describe("the custom_html block", () => {
  test("renders sanitized markup once the sanitizer lands", async () => {
    const { container } = draw('<p class="x">Hello <b>there</b></p>');
    await waitFor(() => expect(container.querySelector("p")).not.toBeNull());
    expect(screen.getByText(/Hello/)).toBeInTheDocument();
    expect(container.querySelector("b")).not.toBeNull();
  });

  test("strips a script rather than rendering it", async () => {
    const { container } = draw('<p>ok</p><script>window.__pwned = 1;</script>');
    await waitFor(() => expect(container.querySelector("p")).not.toBeNull());
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toContain("__pwned");
    expect(window.__pwned).toBeUndefined();
  });

  test("strips an inline event handler", async () => {
    const { container } = draw('<img src="x" onerror="window.__pwned = 1">');
    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    expect(container.querySelector("img").getAttribute("onerror")).toBeNull();
    expect(window.__pwned).toBeUndefined();
  });

  test("the first paint carries none of the raw HTML", () => {
    // Synchronous assertion, deliberately before any await: this is the frame that only
    // exists because the import is async. If the component ever rendered props.html
    // straight through while waiting, the payload would be here.
    const { container } = draw('<p>marker-text</p><script>alert(1)</script>');
    expect(container.innerHTML).not.toContain("marker-text");
    expect(container.innerHTML).not.toContain("alert(1)");
    expect(container.querySelector("script")).toBeNull();
  });

  test("the frame is there from the first paint, so the block does not pop in", () => {
    // The content is deferred; the box it sits in is not. Returning null until the
    // sanitizer landed would shift every block below this one a tick after paint.
    const { container } = draw("<p>anything</p>");
    expect(container.querySelector("section")).not.toBeNull();
    const divs = container.querySelectorAll("div");
    expect(divs[divs.length - 1].innerHTML).toBe("");
  });

  test("empty HTML renders an empty block rather than throwing", async () => {
    const { container } = draw("");
    await waitFor(() => expect(container.querySelector("section")).not.toBeNull());
    // The LAST div is the one dangerouslySetInnerHTML writes into; the ones above it are
    // Frame's own wrappers.
    const divs = container.querySelectorAll("div");
    expect(divs[divs.length - 1].innerHTML).toBe("");
  });
});
