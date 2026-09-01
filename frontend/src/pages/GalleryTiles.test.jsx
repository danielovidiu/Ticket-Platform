/**
 * The Gallery grid's tiles: what they say, and what they wait to be asked.
 *
 * The item count used to sit permanently in the corner of every cover, competing with
 * the photograph for the one part of the tile that is meant to be looked at. It is a
 * detail you go looking for, so it now waits for the pointer. The date took its place
 * as the thing worth saying without being asked — the grid is ordered by it, and an
 * order nobody can read is indistinguishable from no order at all.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Gallery from "./Gallery";

vi.mock("../api", () => ({ http: { get: vi.fn() } }));
import { http } from "../api";

const cover = { media_type: "image", image_url: "/a.jpg", thumbnail_url: "/a.jpg", is_cover: true };
const album = (slug, title, date, count = 10) => ({
  album_id: slug, slug, title, date, count, cover, items: [],
});

const mount = (albums) => {
  http.get.mockResolvedValue({ data: { albums } });
  return render(<MemoryRouter><Gallery /></MemoryRouter>);
};

test("the date rides along with the title, in LLL-YY", async () => {
  mount([album("tresor", "SUPERSANITY X TRESOR BERLIN", "2026-08-15")]);
  const tile = await screen.findByTestId("gallery-album-tresor");
  expect(within(tile).getByTestId("gallery-date-tresor")).toHaveTextContent("Aug-26");
  expect(tile).toHaveTextContent("SUPERSANITY X TRESOR BERLIN");
});

test("an album with no date shows its title alone, not a broken one", async () => {
  // Dateless albums still appear — they fall back to their creation day for ordering,
  // which is not a date anyone typed and so is not one to put on the tile.
  mount([album("undated", "NO DATE YET", null)]);
  await screen.findByTestId("gallery-album-undated");
  expect(screen.queryByTestId("gallery-date-undated")).toBeNull();
  expect(screen.queryByText(/Invalid Date/)).toBeNull();
});

test("the count is rendered but starts hidden, and hover is what reveals it", async () => {
  // jsdom does no layout and cannot hover, so what is asserted is the invariant that
  // produces the behaviour: present in the DOM for screen readers and for the hover
  // rule to act on, transparent until the group is hovered or focused.
  mount([album("tresor", "TRESOR", "2026-08-15", 29)]);
  const count = await screen.findByTestId("gallery-count-tresor");
  expect(count).toHaveTextContent("29 items");
  expect(count.className).toMatch(/\bopacity-0\b/);
  expect(count.className).toMatch(/group-hover:opacity-100/);
});

test("the grid renders albums in the order the server sent them", async () => {
  // Ordering is the server's job — it holds the dates and the fallback rule. The page
  // must not re-sort on its own, or the two disagree the moment they differ.
  mount([
    album("newest", "NEWEST", "2026-08-15"),
    album("middle", "MIDDLE", "2025-03-02"),
    album("oldest", "OLDEST", "2024-01-09"),
  ]);
  await waitFor(() => expect(screen.getAllByTestId(/^gallery-album-/)).toHaveLength(3));
  expect(screen.getAllByTestId(/^gallery-album-/).map((n) => n.dataset.testid)).toEqual([
    "gallery-album-newest", "gallery-album-middle", "gallery-album-oldest",
  ]);
});
