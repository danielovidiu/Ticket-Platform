import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
