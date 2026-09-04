/**
 * The date/time trigger, and why it draws exactly one line.
 *
 * Starts, Ends and Doors sit side by side, as do a tier's Sale starts, Sale ends and
 * Access until — and those rows also carry plain inputs and a select. A trigger that
 * stacked the time under the date stood a head taller than everything beside it, so the
 * date and time now share a line.
 *
 * The invariant that survives from the stacked version is the one that mattered: an empty
 * field and a filled one are the same height, or a row with a blank Doors — Doors usually
 * is — comes out visibly ragged. Height is the real subject and jsdom does no layout, so
 * what these assert is the structure that produces it: nothing ever stacks.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DateTimePicker } from "./datetime-picker";

const OCT = new Date(2025, 9, 18, 20, 0, 0).toISOString();

const trigger = (value) => {
  render(<DateTimePicker value={value} onChange={() => {}} />);
  return screen.getByTestId("datetime-trigger");
};

describe("the trigger", () => {
  test("states the date and the time on one line", () => {
    const el = trigger(OCT);
    expect(el.textContent).toContain("18 Oct 2025");
    expect(el.textContent).toContain("20:00");
    // Nothing stacks: a block child is what made this taller than the inputs beside it.
    expect(el.querySelectorAll("span.block")).toHaveLength(0);
  });

  test("an empty field says so, and stays one line", () => {
    const el = trigger("");
    expect(el.textContent).toContain("Pick date & time");
    expect(el.querySelectorAll("span.block")).toHaveLength(0);
  });

  test("an empty field stacks no more than a filled one, so the row stays level", () => {
    const stacked = (v) => {
      const { container, unmount } = render(<DateTimePicker value={v} onChange={() => {}} />);
      const n = within(container).getByTestId("datetime-trigger").querySelectorAll("span.block").length;
      unmount();
      return n;
    };
    expect(stacked("")).toBe(stacked(OCT));
  });

  test("an empty field promises no time it cannot show", () => {
    // The stacked version printed "--:--" under the hint purely to keep the two heights
    // equal. On one line there is nothing to balance, and a dash pair beside "Pick date &
    // time" would read as a time control that is not there.
    expect(trigger("").textContent).not.toContain("--:--");
  });
});

describe("the popover", () => {
  test("opens straight onto the calendar, with no readout row", async () => {
    // It restated the date and time directly above a calendar showing that day and a
    // time input holding that time — a third copy of the same fact, and the only one
    // you could not act on.
    const user = userEvent.setup();
    render(<DateTimePicker value={OCT} onChange={() => {}} />);
    await user.click(screen.getByTestId("datetime-trigger"));

    const popover = await screen.findByTestId("datetime-popover");
    expect(within(popover).queryByTestId("datetime-readout")).toBeNull();
    expect(popover.textContent).not.toMatch(/Sat 18 Oct 2025/);
  });

  test("still offers the calendar and the time input", async () => {
    // The row went; the two controls that actually set the value did not.
    const user = userEvent.setup();
    render(<DateTimePicker value={OCT} onChange={() => {}} />);
    await user.click(screen.getByTestId("datetime-trigger"));

    const popover = await screen.findByTestId("datetime-popover");
    expect(within(popover).getByRole("grid")).toBeInTheDocument();
    expect(within(popover).getByTestId("datetime-time")).toHaveValue("20:00");
  });
});

/* The date-only mode.
 *
 * Every date field in the admin used to be one of two different things: this popover, or
 * a native <input type="date"> rendering the operating system's own picker — a different
 * typeface, a different palette and a different set of controls, inside an admin that is
 * otherwise deliberately austere. They share this calendar now. What they do not share
 * is a time: a gallery album is filed under a day, and offering an hour to set would be
 * inventing a precision the field does not have.
 */
describe("date-only mode", () => {
  test("states the day, and no time beside it", () => {
    render(<DateTimePicker mode="date" value="2026-08-15" onChange={() => {}} />);
    expect(screen.getByTestId("datetime-trigger").textContent).toBe("15 Aug 2026");
  });

  test("reads a bare day in local time, so it does not render as the day before", () => {
    // `new Date("2026-08-01")` is UTC midnight — the 31st of July for anyone west of
    // Greenwich. The same trap the album date label had to sidestep.
    render(<DateTimePicker mode="date" value="2026-08-01" onChange={() => {}} />);
    expect(screen.getByTestId("datetime-trigger").textContent).toMatch(/1 Aug 2026/);
  });

  test("offers no time input in the popover", async () => {
    const user = userEvent.setup();
    render(<DateTimePicker mode="date" value="2026-08-15" onChange={() => {}} />);
    await user.click(screen.getByTestId("datetime-trigger"));

    const popover = await screen.findByTestId("datetime-popover");
    expect(within(popover).getByRole("grid")).toBeInTheDocument();
    expect(within(popover).queryByTestId("datetime-time")).toBeNull();
  });

  test("emits a plain day rather than a timestamp", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DateTimePicker mode="date" value="2026-08-15" onChange={onChange} />);
    await user.click(screen.getByTestId("datetime-trigger"));
    await user.click(await screen.findByRole("button", { name: /August 20th, 2026/i }));

    expect(onChange).toHaveBeenCalledWith("2026-08-20");
  });

  test("an empty field says so instead of showing a blank box", () => {
    render(<DateTimePicker mode="date" value="" placeholder="No date" onChange={() => {}} />);
    expect(screen.getByTestId("datetime-trigger").textContent).toBe("No date");
  });

  test("the full mode still states a time where the date mode does not", () => {
    // The two modes have to stay distinguishable; this is the half that would rot first.
    const { unmount } = render(<DateTimePicker mode="date" value="2026-08-15" onChange={() => {}} />);
    expect(screen.getByTestId("datetime-trigger").textContent).not.toMatch(/\d\d:\d\d/);
    unmount();
    render(<DateTimePicker value={OCT} onChange={() => {}} />);
    expect(screen.getByTestId("datetime-trigger").textContent).toMatch(/\d\d:\d\d/);
  });
});
