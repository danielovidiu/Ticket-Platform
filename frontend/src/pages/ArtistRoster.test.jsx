/**
 * The roster's filter, and the hover it now shares with the other two grids.
 *
 * Artists, Gallery and Shop sit next to each other in the navigation and were three
 * different kinds of card: the first faded from greyscale to colour, the other two dimmed
 * and darkened their border. Consistency here is the visible half of the change; the
 * filter is the other.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import Artists from "./Artists";

vi.mock("../api", () => ({ http: { get: vi.fn() } }));
import { http } from "../api";

const artist = (slug, name, collab) => ({
  artist_id: slug, slug, name, collab, image_url: "/x.jpg", disciplines: [],
});

const ROSTER = [
  artist("ana", "ANA", "resident"),
  artist("bo", "BO", "guest"),
  artist("cy", "CY", "resident"),
];

const mount = (roster = ROSTER) => {
  http.get.mockResolvedValue({ data: roster });
  render(<MemoryRouter><Artists /></MemoryRouter>);
  return userEvent.setup();
};

// Anchors only. A testid regex also caught the tab bar's own container, which is
// "artist-tabs" and matches every shape a slug does.
const shown = () => [...document.querySelectorAll('a[data-testid^="artist-"]')]
  .map((n) => n.dataset.testid.replace("artist-", ""));

describe("the filter", () => {
  test("opens on All", async () => {
    mount();
    await waitFor(() => expect(shown()).toHaveLength(3));
    expect(screen.getByTestId("artist-tab-all")).toHaveAttribute("aria-pressed", "true");
  });

  test("Residents and Guests each show their own", async () => {
    const user = mount();
    await waitFor(() => expect(shown()).toHaveLength(3));

    await user.click(screen.getByTestId("artist-tab-resident"));
    expect(shown()).toEqual(["ana", "cy"]);

    await user.click(screen.getByTestId("artist-tab-guest"));
    expect(shown()).toEqual(["bo"]);

    await user.click(screen.getByTestId("artist-tab-all"));
    expect(shown()).toEqual(["ana", "bo", "cy"]);
  });

  test("an artist with no collab counts as a resident", async () => {
    // Belt and braces against the migration: it sets every existing artist to resident,
    // and this is what the page does if one somehow arrives without the field rather
    // than dropping them out of both tabs.
    const user = mount([artist("nul", "NUL", undefined), artist("bo", "BO", "guest")]);
    await waitFor(() => expect(shown()).toHaveLength(2));
    await user.click(screen.getByTestId("artist-tab-resident"));
    expect(shown()).toEqual(["nul"]);
  });

  test("an empty tab says so rather than showing a blank grid", async () => {
    const user = mount([artist("ana", "ANA", "resident")]);
    await waitFor(() => expect(shown()).toHaveLength(1));
    await user.click(screen.getByTestId("artist-tab-guest"));
    expect(screen.getByTestId("artists-empty")).toBeVisible();
  });

  test("the roster is fetched once, not per tab", async () => {
    // The list is short and already loaded; a request per click would add latency and
    // nothing else.
    const user = mount();
    await waitFor(() => expect(shown()).toHaveLength(3));
    const calls = http.get.mock.calls.length;
    await user.click(screen.getByTestId("artist-tab-guest"));
    await user.click(screen.getByTestId("artist-tab-all"));
    expect(http.get.mock.calls.length).toBe(calls);
  });
});

describe("the tile's hover", () => {
  test("matches Gallery and Shop: border goes solid, photo dims", async () => {
    mount();
    const tile = await screen.findByTestId("artist-ana");
    expect(tile.className).toMatch(/hover:border-ink/);
    expect(tile.className).toMatch(/transition-colors/);

    const img = within(tile).getByRole("img");
    expect(img.className).toMatch(/group-hover:opacity-80/);
  });

  test("no greyscale left, which was the thing that made it a different card", async () => {
    mount();
    const img = within(await screen.findByTestId("artist-ana")).getByRole("img");
    expect(img.className).not.toMatch(/grayscale/);
  });
});
