/**
 * The shared collapse/expand block, and the two callers whose differences it has to keep.
 *
 * The artist bio's own behaviour is covered in ArtistDisplay.test.jsx and still passes
 * through this component; what is asserted here is the part both callers rely on and the
 * album description's 400-character setting in particular.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import ExpandableText from "./ExpandableText";
import { ALBUM_INTRO_LIMIT } from "../lib/albums";

const long = (n) => "word ".repeat(Math.ceil(n / 5)).slice(0, n).trim();

describe("ExpandableText", () => {
  test("short text renders whole, with no control", () => {
    render(<ExpandableText text="Two lines about a night." limit={400} testId="x" />);
    expect(screen.getByTestId("x")).toHaveTextContent("Two lines about a night.");
    expect(screen.queryByTestId("x-toggle")).not.toBeInTheDocument();
  });

  test("text at exactly the limit is not truncated", () => {
    render(<ExpandableText text={long(400)} limit={400} testId="x" />);
    expect(screen.queryByTestId("x-toggle")).not.toBeInTheDocument();
  });

  test("longer text collapses and offers See more", async () => {
    render(<ExpandableText text={long(900)} limit={400} testId="x" />);
    const toggle = screen.getByTestId("x-toggle");
    expect(toggle).toHaveTextContent("See more");

    const shown = screen.getByTestId("x").textContent.replace("See more", "");
    expect(shown.length).toBeLessThanOrEqual(402); // 400 + the ellipsis
    expect(shown.length).toBeGreaterThan(300); // and not cut far short of it

    await userEvent.click(toggle);
    expect(screen.getByTestId("x-toggle")).toHaveTextContent("See less");
    expect(screen.getByTestId("x").textContent).toContain(long(900).slice(-20));
  });

  test("See less collapses it again", async () => {
    render(<ExpandableText text={long(900)} limit={400} testId="x" />);
    await userEvent.click(screen.getByTestId("x-toggle"));
    await userEvent.click(screen.getByTestId("x-toggle"));
    expect(screen.getByTestId("x-toggle")).toHaveTextContent("See more");
  });

  test("empty text renders nothing at all", () => {
    const { container } = render(<ExpandableText text="" limit={400} testId="x" />);
    expect(container.innerHTML).toBe("");
  });

  test("the collapsed form is plain text, not sliced markdown", () => {
    // `excerpt` strips the marks before counting, which is the whole reason the collapsed
    // state does not reuse the rich renderer: slicing at 400 would cut through a link.
    render(<ExpandableText text={`**bold** ${long(900)}`} limit={400} testId="x" />);
    expect(screen.getByTestId("x").textContent).not.toContain("**");
  });

  test("renderExpanded controls only the OPEN state", async () => {
    render(
      <ExpandableText
        text={long(900)}
        limit={400}
        testId="x"
        renderExpanded={() => <p data-testid="custom">custom render</p>}
      />,
    );
    expect(screen.queryByTestId("custom")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("x-toggle"));
    expect(screen.getByTestId("custom")).toBeInTheDocument();
  });
});

describe("the album description limit", () => {
  test("is 400 — longer than a bio, which is 200", () => {
    // Pinned because two screens read it: the album page truncates at it and the CMS
    // form counts against it. A change here has to be a decision, not a drift.
    expect(ALBUM_INTRO_LIMIT).toBe(400);
  });

  test("an album description under it shows in full", () => {
    render(<ExpandableText text={long(350)} limit={ALBUM_INTRO_LIMIT} testId="album-intro" />);
    expect(screen.queryByTestId("album-intro-toggle")).not.toBeInTheDocument();
  });

  test("an album description over it gets a See more", () => {
    render(<ExpandableText text={long(600)} limit={ALBUM_INTRO_LIMIT} testId="album-intro" />);
    expect(screen.getByTestId("album-intro-toggle")).toHaveTextContent("See more");
  });
});
