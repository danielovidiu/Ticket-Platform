/**
 * The ticket tier card in the event editor.
 *
 * Two rules meet in this component, and both are about what a tier leaves behind.
 *
 * A tier that has sold nothing can be deleted. One that has sold even a single ticket
 * cannot — those sales stay valid and indexed, and the tier row is what the door reads an
 * access window from and what an export reads a tier name from. So the delete button is
 * not merely disabled on a sold tier, it is replaced by the sentence saying what to do
 * instead: archive it, which is reversible where a delete is not.
 *
 * The other rule is the group ticket. Price is the PACK's, capacity is still in
 * individual tickets, and the per-ticket rate is derived and shown rather than typed —
 * because that derived number is what a refund is settled on.
 *
 * The server enforces both independently (backend/tests/test_tier_lifecycle_and_packs.py).
 * These are about what the editor offers, which is the half a promoter actually meets.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TierCard } from "./Admin";

const TIER = {
  wave_id: "w1", tier_id: 1, name: "EARLY BIRD",
  price_ron: 100, capacity: 100, pack_size: 1, status: "active",
  starts_at: "2026-01-01T00:00:00+00:00", ends_at: "2026-06-01T00:00:00+00:00",
  access_until: "", access_from: "", sold: 0, held: 0,
};

const draw = (overrides = {}, props = {}) =>
  render(<TierCard wave={{ ...TIER, ...overrides }} index={0}
                   onField={props.onField || (() => {})}
                   onFields={props.onFields || (() => {})}
                   onTouchEndsAt={props.onTouchEndsAt || (() => {})}
                   onDelete={props.onDelete || (() => {})}
                   eventMaxPerUser={props.eventMaxPerUser} />);

describe("deleting a tier", () => {
  test("a tier that has sold nothing offers Delete", () => {
    draw({ sold: 0, held: 0 });
    expect(screen.getByTestId("wave-delete-0")).toBeInTheDocument();
  });

  test("clicking it asks the form to drop the tier", async () => {
    const onDelete = vi.fn();
    draw({ sold: 0, held: 0 }, { onDelete });
    await userEvent.click(screen.getByTestId("wave-delete-0"));
    expect(onDelete).toHaveBeenCalled();
  });

  test("one ticket sold takes the button away entirely", () => {
    // Not disabled — gone. A greyed-out Delete invites a click that can never work;
    // the space is better spent saying what to do instead.
    draw({ sold: 1 });
    expect(screen.queryByTestId("wave-delete-0")).toBeNull();
  });

  test("and says to archive it, with the reason", () => {
    draw({ sold: 1 });
    const note = screen.getByTestId("wave-undeletable-0");
    expect(note.textContent).toMatch(/archive/i);
    expect(note.textContent).toMatch(/stay valid/i);
  });

  test("a live checkout blocks it too, and says so differently", () => {
    // Nothing has sold, so "sold tickets" would be untrue — and unlike a sale, this one
    // clears on its own.
    draw({ sold: 0, held: 4 });
    expect(screen.queryByTestId("wave-delete-0")).toBeNull();
    expect(screen.getByTestId("wave-undeletable-0").textContent).toMatch(/hold/i);
  });

  test("the count is shown either way, because it is the reason", () => {
    draw({ sold: 12, held: 4 });
    expect(screen.getByTestId("wave-sold-0").textContent).toMatch(/12 sold/);
    expect(screen.getByTestId("wave-sold-0").textContent).toMatch(/4 held/);
  });

  test("no held count is printed when nothing is held", () => {
    draw({ sold: 3, held: 0 });
    expect(screen.getByTestId("wave-sold-0").textContent).not.toMatch(/held/);
  });
});

describe("the three states", () => {
  test("every one is offered, so archiving is undone from the same control", () => {
    draw({ status: "archived" });
    const options = within(screen.getByTestId("wave-status-0")).getAllByRole("option");
    expect(options.map((o) => o.value)).toEqual(["active", "paused", "archived"]);
  });

  test("an archived tier reads as archived rather than as an empty control", () => {
    draw({ status: "archived" });
    expect(screen.getByTestId("wave-status-0").value).toBe("archived");
  });

  test("a tier with no state at all reads as on sale", () => {
    // Every tier written before states existed. It behaved as active, so it says active.
    const { status, ...noStatus } = TIER;
    render(<TierCard wave={noStatus} index={0} onField={() => {}} onFields={() => {}}
                     onTouchEndsAt={() => {}} onDelete={() => {}} />);
    expect(screen.getByTestId("wave-status-0").value).toBe("active");
  });

  test("choosing one reports it up", async () => {
    const onField = vi.fn();
    draw({}, { onField });
    await userEvent.selectOptions(screen.getByTestId("wave-status-0"), "paused");
    expect(onField).toHaveBeenCalledWith("status", "paused");
  });

  test("an archived tier says it is hidden and can come back", () => {
    expect(screen.queryByTestId("wave-archived-note-0")).toBeNull();
    draw({ status: "archived" });
    expect(screen.getByTestId("wave-archived-note-0").textContent).toMatch(/back/i);
  });

  test("and is drawn as set aside rather than as an ordinary tier", () => {
    draw({ status: "archived" });
    expect(screen.getByTestId("wave-row-0").className).toMatch(/opacity-60/);
  });
});

describe("group tickets", () => {
  test("an ordinary tier says nothing about packs", () => {
    draw({ pack_size: 1 });
    expect(screen.queryByTestId("wave-pack-note-0")).toBeNull();
  });

  test("the price field names what is being priced", () => {
    // "Price for 4", not "Price" — the promoter types the pack price, and the label is
    // the only thing that says so before the money is wrong.
    draw({ pack_size: 4, price_ron: 300 });
    expect(screen.getByText(/Price for 4/i)).toBeInTheDocument();
  });

  test("the per-ticket rate is derived and shown", () => {
    draw({ pack_size: 4, price_ron: 300, capacity: 200 });
    expect(screen.getByTestId("wave-pack-note-0").textContent).toMatch(/75\.00 per ticket/);
  });

  test("so is how many packs the stock holds", () => {
    draw({ pack_size: 4, price_ron: 300, capacity: 200 });
    expect(screen.getByTestId("wave-pack-note-0").textContent).toMatch(/50 packs/);
  });

  test("a capacity that is not a whole number of packs is flagged with the fix", () => {
    // 50 in threes strands two tickets nobody can buy. The server refuses this on save;
    // saying so here means the editor sees it while the number is still under the cursor.
    draw({ pack_size: 3, price_ron: 90, capacity: 50 });
    const note = screen.getByTestId("wave-pack-note-0").textContent;
    expect(note).toMatch(/2 tickets nobody can buy/);
    expect(note).toMatch(/multiple of 3/);
  });

  test("a capacity that divides cleanly is not flagged", () => {
    draw({ pack_size: 4, price_ron: 300, capacity: 200 });
    expect(screen.getByTestId("wave-pack-note-0").textContent).not.toMatch(/nobody can buy/);
  });

  test("pack size never reports below one", async () => {
    // A cleared field is an ordinary tier, not a tier that issues nothing — and a typed
    // 0 is a tier that would issue no tickets for money taken.
    const onField = vi.fn();
    draw({ pack_size: 4 }, { onField });
    await userEvent.clear(screen.getByTestId("wave-pack-size-0"));
    await userEvent.type(screen.getByTestId("wave-pack-size-0"), "0");
    const sizes = onField.mock.calls.filter(([k]) => k === "pack_size").map(([, v]) => v);
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBe(1);
  });
});

/**
 * The two selling rules that moved down from the event.
 *
 * A cap and a sold-out message used to be the night's, one answer each. They are the
 * tier's now, because a night selling four-packs alongside general admission needs to say
 * "one per person" about one and "six" about the other.
 *
 * Blank is the load-bearing state here. It is not zero and it is not four — it is "this
 * tier has no rule of its own", which is what every tier written before the field existed
 * says, and what keeps the event's number reaching them.
 */
describe("per-tier selling rules", () => {
  test("a tier with no cap of its own shows the event's as the placeholder", () => {
    draw({ max_tickets_per_user: null }, { eventMaxPerUser: 6 });
    const cap = screen.getByTestId("wave-max-per-user-0");
    expect(cap).toHaveValue(null);
    expect(cap).toHaveAttribute("placeholder", "6");
  });

  test("a tier that sets its own cap shows that, not the event's", () => {
    draw({ max_tickets_per_user: 1 }, { eventMaxPerUser: 6 });
    expect(screen.getByTestId("wave-max-per-user-0")).toHaveValue(1);
  });

  test("clearing the cap reports null, not zero", async () => {
    // Zero would be a tier nobody may buy from. Null is "no opinion" — the event's
    // number stands — and the two must never be confused on the way to the server.
    const onField = vi.fn();
    draw({ max_tickets_per_user: 2 }, { onField });
    await userEvent.clear(screen.getByTestId("wave-max-per-user-0"));
    const caps = onField.mock.calls.filter(([k]) => k === "max_tickets_per_user");
    expect(caps.at(-1)[1]).toBeNull();
  });

  test("a typed cap is reported as a number", async () => {
    const onField = vi.fn();
    draw({ max_tickets_per_user: null }, { onField });
    await userEvent.type(screen.getByTestId("wave-max-per-user-0"), "3");
    const caps = onField.mock.calls.filter(([k]) => k === "max_tickets_per_user");
    expect(caps.at(-1)[1]).toBe(3);
  });

  test("the sold-out message is the tier's own words", async () => {
    const onField = vi.fn();
    draw({ sold_out_message: "" }, { onField });
    await userEvent.type(screen.getByTestId("wave-sold-out-message-0"), "A");
    expect(onField).toHaveBeenCalledWith("sold_out_message", "A");
  });
});
