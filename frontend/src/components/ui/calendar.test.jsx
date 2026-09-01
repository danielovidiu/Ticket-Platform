import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Calendar } from "./calendar";

/* This file exists because the react-day-picker v8 -> v10 upgrade is the kind that does
 * not throw. DayPicker takes an arbitrary classNames object, so any key left on its v8
 * name is silently ignored: the calendar still renders, any test that only asked "did a
 * calendar appear?" still passes, and the sole symptom is an unstyled grid inside a
 * popover that three people ever open. So these assert where the classes LAND.
 *
 * The trap in particular: v8's `day` is v10's `day_button`, while `day` still exists as a
 * key and now means the cell. A file left on the v8 names puts the button's styling on
 * the <td> and leaves the <button> bare, which is a calendar of unstyled numbers.
 */
const JUNE = new Date(2026, 5, 15, 12, 0, 0); // local noon: no date shift from the clock

/* A month spans four week rows (February 2026 starts on a Sunday and has 28 days) to
   six (August 2026). Left alone, the popover changed height as you paged through it. */
const FEB = new Date(2026, 1, 15, 12, 0, 0);
const AUG = new Date(2026, 7, 15, 12, 0, 0);

describe("Calendar", () => {
  it("renders a month grid, seven weekday headers, and both nav buttons", () => {
    const { container } = render(<Calendar mode="single" month={JUNE} onSelect={() => {}} />);
    expect(screen.getByRole("grid")).toBeInTheDocument();
    // head_row/head_cell became weekdays/weekday.
    const headers = container.querySelectorAll("th");
    expect(headers).toHaveLength(7);
    expect(headers[0].className).toContain("text-ink-4");
    // IconLeft + IconRight became one Chevron that is told its orientation. Two labelled
    // buttons is what proves the swap took; without it DayPicker renders its own default.
    expect(screen.getByRole("button", { name: /previous month/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next month/i })).toBeInTheDocument();
  });

  it("reports the day that was clicked", async () => {
    const onSelect = vi.fn();
    render(<Calendar mode="single" month={JUNE} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: /June 20th, 2026/i }));
    const picked = onSelect.mock.calls[0][0];
    expect(picked.getDate()).toBe(20);
    expect(picked.getMonth()).toBe(5);
    expect(picked.getFullYear()).toBe(2026);
  });

  it("styles the cell as a cell and the button as a button", () => {
    const { container } = render(<Calendar mode="single" month={JUNE} onSelect={() => {}} />);
    const cell = [...container.querySelectorAll("td")].find((t) => t.textContent.trim() === "20");
    // `day` -> the <td>: layout only.
    expect(cell.className).toContain("p-0");
    // `day_button` -> the <button>: the 8x8 hit area and the hover fill. This is the
    // assertion that fails if the keys are left on their v8 names.
    const button = cell.querySelector("button");
    expect(button.className).toMatch(/\bh-8\b/);
    expect(button.className).toMatch(/\bw-8\b/);
    expect(button.className).toContain("hover:bg-ink");
  });

  it("paints the selected day through the cell to the button", () => {
    const { container } = render(<Calendar mode="single" month={JUNE} selected={JUNE} onSelect={() => {}} />);
    // `selected` lost its day_ prefix AND moved to the cell, so it has to reach past the
    // cell to fill the button — the thing that actually looks selected.
    // v10 marks state with data attributes on the cell, not with rdp-* classes.
    const selected = container.querySelector("[data-selected=\"true\"]");
    expect(selected.tagName).toBe("TD");
    expect(selected.className).toContain("[&>button]:bg-ink");
    expect(selected.textContent.trim()).toBe("15");
  });

  it("marks today", () => {
    const { container } = render(<Calendar mode="single" onSelect={() => {}} />);
    const today = container.querySelector("[data-today]");
    expect(today).toBeTruthy();
    expect(today.textContent.trim()).toBe(String(new Date().getDate()));
  });
});

describe("month height", () => {
  const weekRows = (month) => {
    const { container } = render(<Calendar mode="single" month={month} onSelect={() => {}} />);
    return container.querySelectorAll("tbody tr").length;
  };

  it("renders six week rows for a month that only needs four", () => {
    // February 2026: Sun 1st, 28 days — exactly four weeks of its own.
    expect(weekRows(FEB)).toBe(6);
  });

  it("renders six week rows for a month that needs six", () => {
    expect(weekRows(AUG)).toBe(6);
  });

  it("gives every month in a year the same number of rows", () => {
    const counts = new Set(
      Array.from({ length: 12 }, (_, m) => weekRows(new Date(2026, m, 15, 12, 0, 0)))
    );
    expect([...counts]).toEqual([6]);
  });

  it("can be turned off, for a caller that wants the tight grid", () => {
    const { container } = render(
      <Calendar mode="single" month={FEB} fixedWeeks={false} onSelect={() => {}} />
    );
    expect(container.querySelectorAll("tbody tr").length).toBeLessThan(6);
  });
});

/* The drill-down.
 *
 * Reaching a date years away used to mean one click per month — sixty of them to go
 * back five years, on a control whose whole job is picking a date. The caption's two
 * halves are buttons now: the month opens all twelve, the year opens a window of
 * eleven, and each step lands one level closer to a day.
 */
const OCT_2025 = new Date(2025, 9, 18, 12, 0, 0);

const openPicker = (props = {}) => {
  render(<Calendar mode="single" selected={OCT_2025} defaultMonth={OCT_2025} onSelect={() => {}} {...props} />);
  return userEvent.setup();
};

describe("where the panel opens", () => {
  it("shows days, at the month the field already holds", () => {
    openPicker();
    expect(screen.getByRole("grid")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-month-label")).toHaveTextContent("October");
    expect(screen.getByTestId("calendar-year-label")).toHaveTextContent("2025");
  });
});

describe("clicking the month", () => {
  it("shows all twelve months instead of days", async () => {
    const user = openPicker();
    await user.click(screen.getByTestId("calendar-month-label"));

    const months = screen.getByTestId("calendar-months");
    expect(within(months).getAllByRole("button")).toHaveLength(12);
    expect(screen.queryByRole("grid")).toBeNull(); // the days stepped aside
  });

  it("picking one returns to that month's days", async () => {
    const user = openPicker();
    await user.click(screen.getByTestId("calendar-month-label"));
    await user.click(screen.getByTestId("calendar-month-2")); // March

    expect(screen.getByRole("grid")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-month-label")).toHaveTextContent("March");
    expect(screen.getByTestId("calendar-year-label")).toHaveTextContent("2025");
  });
});

describe("clicking the year", () => {
  it("offers five years either side, not a list of days", async () => {
    const user = openPicker();
    await user.click(screen.getByTestId("calendar-year-label"));

    const years = screen.getByTestId("calendar-years");
    expect(within(years).getAllByRole("button")).toHaveLength(11);
    expect(screen.getByTestId("calendar-year-2020")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-year-2030")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-year-2019")).toBeNull();
    expect(screen.queryByTestId("calendar-year-2031")).toBeNull();
    expect(screen.getByTestId("calendar-range-label")).toHaveTextContent("2020 – 2030");
  });

  it("picking a year drops to that year's months", async () => {
    // Not straight back to the days: the year says which year, and which month is the
    // next question rather than one answered on the reader's behalf with whichever
    // month happened to be showing.
    const user = openPicker();
    await user.click(screen.getByTestId("calendar-year-label"));
    await user.click(screen.getByTestId("calendar-year-2021"));

    expect(screen.getByTestId("calendar-months")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-year-label")).toHaveTextContent("2021");
  });

  it("puts any year on offer three clicks from a day", async () => {
    const user = openPicker();
    await user.click(screen.getByTestId("calendar-year-label"));
    await user.click(screen.getByTestId("calendar-year-2022"));
    await user.click(screen.getByTestId("calendar-month-5")); // June

    expect(screen.getByTestId("calendar-month-label")).toHaveTextContent("June");
    expect(screen.getByTestId("calendar-year-label")).toHaveTextContent("2022");
    expect(screen.getByRole("grid")).toBeInTheDocument();
  });
});

describe("the chevrons", () => {
  it("step by the unit the grid under them is made of", async () => {
    const user = openPicker();
    const prev = () => screen.getByTestId("calendar-prev");
    const next = () => screen.getByTestId("calendar-next");

    // Days: a month at a time.
    await user.click(next());
    expect(screen.getByTestId("calendar-month-label")).toHaveTextContent("November");
    await user.click(prev());

    // Months: a year at a time.
    await user.click(screen.getByTestId("calendar-month-label"));
    await user.click(next());
    expect(screen.getByTestId("calendar-year-label")).toHaveTextContent("2026");

    // Years: a whole window at a time, so the ranges tile. From 2026 the window is
    // 2021–2031; one step back centres on 2015, putting 2020 directly against 2021
    // with no year shown twice and none skipped.
    await user.click(screen.getByTestId("calendar-year-label"));
    expect(screen.getByTestId("calendar-range-label")).toHaveTextContent("2021 – 2031");
    await user.click(prev());
    expect(screen.getByTestId("calendar-range-label")).toHaveTextContent("2010 – 2020");
  });

  it("say which unit they move, so the label is never confidently wrong", async () => {
    const user = openPicker();
    expect(screen.getByRole("button", { name: /previous month/i })).toBeInTheDocument();

    await user.click(screen.getByTestId("calendar-month-label"));
    expect(screen.getByRole("button", { name: /previous year$/i })).toBeInTheDocument();

    await user.click(screen.getByTestId("calendar-year-label"));
    expect(screen.getByRole("button", { name: /previous years/i })).toBeInTheDocument();
  });
});
