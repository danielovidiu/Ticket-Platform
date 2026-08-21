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
