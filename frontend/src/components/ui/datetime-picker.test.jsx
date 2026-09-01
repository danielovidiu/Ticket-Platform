/**
 * The date/time trigger, and why it always draws two lines.
 *
 * Starts, Ends and Doors sit side by side in a three-column grid, as do a tier's Sale
 * starts, Sale ends and Access until. The trigger used to render one line when the
 * field was empty and two when it held a value, so a row with any blank field — Doors
 * usually is — came out visibly ragged. Height is the thing being asserted here, and
 * jsdom does not do layout, so what these check is the invariant that produces it: the
 * same number of lines either way.
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
  test("draws two lines when a date is set", () => {
    const lines = trigger(OCT).querySelectorAll("span.block");
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toBe("18 Oct 2025");
    expect(lines[1].textContent).toBe("20:00");
  });

  test("draws two lines when the field is empty, so the row stays level", () => {
    const lines = trigger("").querySelectorAll("span.block");
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toBe("Pick date & time");
    expect(lines[1].textContent).toBe("--:--"); // a placeholder, not a blank
  });

  test("an empty field has the same line count as a filled one", () => {
    const count = (v) => {
      const { container, unmount } = render(<DateTimePicker value={v} onChange={() => {}} />);
      const n = within(container).getByTestId("datetime-trigger").querySelectorAll("span.block").length;
      unmount();
      return n;
    };
    expect(count("")).toBe(count(OCT));
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
  test("draws one line, with no time under it", () => {
    render(<DateTimePicker mode="date" value="2026-08-15" onChange={() => {}} />);
    const lines = screen.getByTestId("datetime-trigger").querySelectorAll("span.block");
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toBe("15 Aug 2026");
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

  test("the full mode still carries its time row", () => {
    // The two modes have to stay distinguishable; this is the half that would rot first.
    render(<DateTimePicker value={OCT} onChange={() => {}} />);
    const lines = screen.getByTestId("datetime-trigger").querySelectorAll("span.block");
    expect(lines).toHaveLength(2);
  });
});
