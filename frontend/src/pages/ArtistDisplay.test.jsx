/**
 * What the roster tile and the artist page must show.
 *
 * Two rules with teeth. The tile lists three disciplines and counts the rest, and the
 * overflow marker is NOT a link — the whole tile is already an anchor to the artist, and
 * an <a> nested in an <a> is invalid markup that browsers unnest, leaving a control that
 * looks clickable and is not.
 *
 * The bio is cut to 200 characters of TEXT. Slicing the markdown source instead would
 * spend the budget on syntax the reader never sees and cut through the middle of a mark;
 * expanding has to bring the real formatting back, not a second copy of the excerpt.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import ArtistDetail, { Bio } from "./ArtistDetail";
import Artists from "./Artists";

vi.mock("../api", () => ({ http: { get: vi.fn() } }));
import { http } from "../api";

const roster = (artists) => {
  http.get.mockResolvedValue({ data: artists });
  return render(<MemoryRouter><Artists /></MemoryRouter>);
};

const ARTIST = (over = {}) => ({
  artist_id: "art_1", name: "VOID ORCHESTRA", slug: "void-orchestra",
  image_url: "", disciplines: [], ...over,
});

describe("roster tile", () => {
  test("lists three disciplines and counts the remainder", async () => {
    roster([ARTIST({ disciplines: ["DJ", "Producer", "VJ", "Dancer", "Curator"] })]);
    const tags = await screen.findByTestId("artist-void-orchestra-disciplines");
    expect(within(tags).getByText("DJ")).toBeInTheDocument();
    expect(within(tags).getByText("VJ")).toBeInTheDocument();
    expect(within(tags).queryByText("Dancer")).not.toBeInTheDocument();
    expect(within(tags).getByText("+2 more")).toBeInTheDocument();
  });

  test("no overflow marker when they all fit", async () => {
    roster([ARTIST({ disciplines: ["DJ", "Producer"] })]);
    const tags = await screen.findByTestId("artist-void-orchestra-disciplines");
    expect(tags.textContent).not.toMatch(/more/);
  });

  test("exactly three is not an overflow", async () => {
    roster([ARTIST({ disciplines: ["DJ", "Producer", "VJ"] })]);
    const tags = await screen.findByTestId("artist-void-orchestra-disciplines");
    expect(tags.textContent).not.toMatch(/more/);
  });

  test("an artist with no disciplines gets no tag row at all", async () => {
    roster([ARTIST()]);
    await screen.findByTestId("artist-void-orchestra");
    expect(screen.queryByTestId("artist-void-orchestra-disciplines")).not.toBeInTheDocument();
  });

  test("the overflow marker is not a nested anchor", async () => {
    roster([ARTIST({ disciplines: ["DJ", "Producer", "VJ", "Dancer"] })]);
    const tags = await screen.findByTestId("artist-void-orchestra-disciplines");
    expect(tags.querySelector("a")).toBeNull();
    // The tile itself is still the link.
    expect(screen.getByTestId("artist-void-orchestra").tagName).toBe("A");
  });
});

describe("bio", () => {
  const LONG = "word ".repeat(80);

  test("a short bio renders in full with no toggle", () => {
    render(<Bio text="Berlin-based collective." />);
    expect(screen.queryByTestId("artist-bio-toggle")).not.toBeInTheDocument();
    expect(screen.getByText(/Berlin-based collective/)).toBeInTheDocument();
  });

  test("a long bio is cut and offers see more", () => {
    render(<Bio text={LONG} />);
    const toggle = screen.getByTestId("artist-bio-toggle");
    expect(toggle).toHaveTextContent("See more");
    const shown = screen.getByTestId("artist-bio").textContent.replace("See more", "");
    expect(shown.length).toBeLessThan(LONG.length);
  });

  test("markdown marks do not spend the character budget", () => {
    // 40 characters of text wearing marks; well under the 200 limit either way, but
    // slicing the source would leave a dangling `**` in the output.
    render(<Bio text={`**${"a".repeat(40)}**`} />);
    expect(screen.queryByTestId("artist-bio-toggle")).not.toBeInTheDocument();
    expect(screen.getByText("a".repeat(40))).toBeInTheDocument();
  });

  test("expanding restores the real formatting rather than more excerpt", async () => {
    const md = `Lead **bold** and *italic*. ${LONG}`;
    const { container } = render(<Bio text={md} />);
    expect(container.querySelector("strong")).toBeNull();

    await userEvent.click(screen.getByTestId("artist-bio-toggle"));

    expect(container.querySelector("strong")).toHaveTextContent("bold");
    expect(container.querySelector("em")).toHaveTextContent("italic");
    expect(screen.getByTestId("artist-bio-toggle")).toHaveTextContent("See less");
  });

  test("it collapses again", async () => {
    const { container } = render(<Bio text={`**bold** ${LONG}`} />);
    await userEvent.click(screen.getByTestId("artist-bio-toggle"));
    await userEvent.click(screen.getByTestId("artist-bio-toggle"));
    expect(container.querySelector("strong")).toBeNull();
    expect(screen.getByTestId("artist-bio-toggle")).toHaveTextContent("See more");
  });
});

/**
 * The order of the social buttons.
 *
 * `links` is a bag whose iteration order is whatever the admin form happened to write, so
 * sorting SOCIAL_PLATFORMS alone changed the form's fields and left these in insertion
 * order — a real artist rendered YouTube, Facebook, SoundCloud, Instagram after the
 * constant was already A-Z. The page has to walk the vocabulary, not the stored object.
 */
describe("artist social links", () => {
  const withLinks = (links) => {
    http.get.mockResolvedValue({ data: {
      artist_id: "a1", name: "VOID", slug: "void", bio: "", image_url: "",
      disciplines: [], albums: [], links,
    }});
    return render(
      <MemoryRouter initialEntries={["/artists/void"]}>
        <Routes><Route path="/artists/:slug" element={<ArtistDetail />} /></Routes>
      </MemoryRouter>
    );
  };

  const buttonLabels = () =>
    [...document.querySelectorAll("a.btn-primary")].map((a) => a.textContent);

  test("they render A-Z however the object was written", async () => {
    withLinks({ youtube: "https://y", facebook: "https://f",
                soundcloud: "https://s", instagram: "https://i" });
    await screen.findByText("VOID");
    expect(buttonLabels()).toEqual(["Facebook", "Instagram", "SoundCloud", "YouTube"]);
  });

  test("a key the vocabulary does not know still renders, after the known ones", async () => {
    // Dropping it silently would lose a link an editor deliberately stored.
    withLinks({ youtube: "https://y", bandcamp: "https://b" });
    await screen.findByText("VOID");
    expect(buttonLabels()).toEqual(["YouTube", "bandcamp"]);
  });

  test("empty values are not rendered as empty buttons", async () => {
    withLinks({ youtube: "https://y", facebook: "" });
    await screen.findByText("VOID");
    expect(buttonLabels()).toEqual(["YouTube"]);
  });
});
