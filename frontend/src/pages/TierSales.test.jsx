/**
 * The per-tier sales readout in the admin event list.
 *
 * Each tier used to be its own flex row, which meant the three columns lined up only by
 * coincidence, and the count sat in a fixed w-28 that its own content did not fit —
 * "88/100 · 12 left" is eighteen mono characters at 0.15em tracking, so "left" wrapped
 * onto a second line and the rows came out different heights.
 *
 * jsdom does no layout, so none of that is measurable here. What is testable is the
 * structure that produces the alignment: one grid over every tier rather than a
 * container per row, and a count that cannot break.
 */
import { render, within } from "@testing-library/react";
import { TierSales } from "./Admin";

const WAVES = [
  { wave_id: "1", name: "EARLY BIRD", capacity: 100, available: 12 },
  { wave_id: "2", name: "GENERAL", capacity: 250, available: 250 },
  { wave_id: "3", name: "VIP", capacity: 40, available: 0 },
];

const draw = (waves) => {
  const { container } = render(<TierSales waves={waves} />);
  return within(container).getByTestId("tier-sales");
};

describe("layout", () => {
  test("is one grid over every tier, not a row container each", () => {
    // Three cells per tier, all direct children of the same grid. This is what makes
    // column widths shared across rows instead of computed per row.
    const grid = draw(WAVES);
    expect(grid.children).toHaveLength(WAVES.length * 3);
    expect(grid.className).toMatch(/\bgrid\b/);
  });

  test("the count column is sized by content, so every row ends on one edge", () => {
    // `auto` takes the widest count in the list; a fixed width was the original bug.
    expect(draw(WAVES).className).toContain("sm:grid-cols-[minmax(0,1fr)_5rem_auto]");
  });

  test("no count can wrap", () => {
    const grid = draw(WAVES);
    const counts = [...grid.children].filter((_, i) => i % 3 === 2);
    expect(counts).toHaveLength(3);
    for (const c of counts) expect(c.className).toContain("whitespace-nowrap");
  });

  test("counts use tabular figures, so digits do not jitter between rows", () => {
    const counts = [...draw(WAVES).children].filter((_, i) => i % 3 === 2);
    for (const c of counts) expect(c.className).toContain("tabular-nums");
  });
});

describe("what it says", () => {
  test("shows sold over capacity and how many are left", () => {
    expect(draw(WAVES).textContent).toContain("88/100");
    expect(draw(WAVES).textContent).toContain("12 left");
  });

  test("an unsold tier reads as its full capacity left, not as zero sold", () => {
    expect(draw(WAVES).textContent).toContain("0/250");
    expect(draw(WAVES).textContent).toContain("250 left");
  });

  test("a tier at zero says sold out rather than '0 left'", () => {
    const grid = draw(WAVES);
    expect(grid.textContent).toContain("sold out");
    expect(grid.textContent).not.toContain("0 left · ");
  });

  test("an event with no tiers says so instead of drawing an empty grid", () => {
    const { container } = render(<TierSales waves={[]} />);
    expect(container.textContent).toBe("No tiers");
    expect(within(container).queryByTestId("tier-sales")).toBeNull();
  });

  test("a missing available count falls back to the full capacity", () => {
    // The server omits `available` on a tier nobody has touched.
    const grid = draw([{ wave_id: "x", name: "GENERAL", capacity: 50 }]);
    expect(grid.textContent).toContain("0/50");
    expect(grid.textContent).toContain("50 left");
  });
});

describe("tier state and pack size", () => {
  test("a tier off sale is named as which kind of off", () => {
    // "Archived" and "paused" both mean "not selling" for different reasons and with
    // different remedies, so neither is collapsed into a plain greyed-out row.
    const grid = draw([
      { wave_id: "a", name: "FRIENDS", capacity: 20, available: 20, status: "archived" },
      { wave_id: "b", name: "VIP", capacity: 40, available: 40, status: "paused" },
    ]);
    expect(grid.textContent).toContain("[arch]");
    expect(grid.textContent).toContain("[paused]");
  });

  test("an active tier carries no state marker", () => {
    expect(draw([{ wave_id: "a", name: "GENERAL", capacity: 50, available: 50, status: "active" }])
      .textContent).not.toContain("[");
  });

  test("a group tier says how many tickets one purchase is", () => {
    expect(draw([{ wave_id: "a", name: "GROUP", capacity: 200, available: 200, pack_size: 4 }])
      .textContent).toContain("×4");
  });

  test("the issued count is preferred over capacity minus available", () => {
    // The two differ by whatever a live checkout is holding. The editor's delete gate
    // reads the issued count, and a list disagreeing with it on the same screen is how
    // a promoter comes to believe a tier they cannot delete has sold nothing.
    const grid = draw([
      { wave_id: "a", name: "GENERAL", capacity: 100, available: 90, sold: 6 },
    ]);
    expect(grid.textContent).toContain("6/100");
    // "Left" stays the stock the server is holding, which is the other four seats being
    // held by a checkout in flight. Six sold and ninety left is the honest reading of a
    // tier with four in someone's basket.
    expect(grid.textContent).toContain("90 left");
  });

  test("and falls back to that arithmetic when no count was sent", () => {
    const grid = draw([{ wave_id: "a", name: "GENERAL", capacity: 100, available: 90 }]);
    expect(grid.textContent).toContain("10/100");
  });
});
