import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { DayPicker } from "react-day-picker"

import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"

/* react-day-picker v10. Vendored from shadcn/ui for v8 and rewritten against the v8-to-v10
 * class map, because v8 declared peers this app is two majors past — React ^18 against
 * React 19, date-fns ^3 against 4 — and yarn said so on every install. v10 peers only
 * `react >=16.8.0` and depends on date-fns itself, so the version this app resolves is no
 * longer something a peer range has an opinion about.
 *
 * Three things moved, and all three are here rather than in a changelog nobody will read
 * at the moment they matter:
 *
 *   - Every class key was renamed. table -> month_grid, head_row -> weekdays,
 *     head_cell -> weekday, row -> week, caption -> month_caption.
 *   - The day cell and the thing you click are now separate keys. v8's `cell` is v10's
 *     `day` (the td) and v8's `day` is v10's `day_button`. This is the one that bites:
 *     `day` still exists as a key, so a v8 file upgrades without erroring and silently
 *     puts the button styling on the cell.
 *   - Modifier keys lost their day_ prefix, and they land on the CELL. Hence the
 *     [&>button] selectors below — `selected` has to reach past the cell to paint the
 *     button, which is what actually looks selected.
 *
 * The two navigation icons became one `Chevron` with an `orientation`.
 *
 * Colours are this site's tokens, not shadcn's. The calendar only ever renders inside
 * DateTimePicker's popover, which is bg-surface/text-ink, so a muted-foreground weekday
 * header was reading from a palette the container does not use; ink-4 is the dim role the
 * picker's own placeholder already uses, and it follows the CMS theme.
 */
function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  /* Every month renders six week rows, padded with the neighbouring months' days.
   *
   * Without it a month spans four rows (February 2026) to six (August 2026), so the
   * popover changed height as you paged through it and the buttons under the grid
   * moved out from under the cursor. Paying for two rows of grey filler is the cheaper
   * side of that trade. Needs showOutsideDays to have anything to pad with. */
  fixedWeeks = true,
  ...props
}) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      fixedWeeks={fixedWeeks}
      className={cn("p-3", className)}
      classNames={{
        // Relative, because v10 renders `nav` as a SIBLING of the month rather than
        // inside the caption the way v8 did. The chevrons need something to anchor to;
        // without this they position against the popover and land on its readout row.
        months: "relative flex flex-col sm:flex-row gap-4",
        month: "flex flex-col gap-4",
        // h-7 matches the nav buttons, so the centred title sits on their line.
        month_caption: "flex h-7 items-center justify-center",
        caption_label: "text-sm font-medium",
        nav: "absolute inset-x-0 top-0 z-10 flex items-center justify-between",
        // Flanking the caption, laid out by the nav's justify-between rather than each
        // being absolutely placed — v8 positioned them individually because they lived
        // inside the caption.
        button_previous: cn(
          buttonVariants({ variant: "outline" }),
          "h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100"
        ),
        button_next: cn(
          buttonVariants({ variant: "outline" }),
          "h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100"
        ),
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "text-ink-4 w-8 font-normal text-[0.8rem]",
        week: "flex w-full mt-2",
        day: "relative p-0 text-center text-sm focus-within:relative focus-within:z-20",
        day_button: cn(
          buttonVariants({ variant: "ghost" }),
          "h-8 w-8 p-0 font-normal hover:bg-ink hover:text-page focus:bg-ink focus:text-page"
        ),
        // On the cell, so they have to reach the button to be seen. Written as one
        // selector each rather than spread across day_button, which cannot know whether
        // its own cell is selected.
        selected: "[&>button]:bg-ink [&>button]:text-page [&>button]:hover:bg-ink [&>button]:hover:text-page",
        today: "[&>button]:text-brand [&>button]:font-bold",
        outside: "text-ink-4 opacity-60",
        disabled: "text-ink-4 opacity-50",
        range_start: "[&>button]:rounded-l-md",
        range_end: "[&>button]:rounded-r-md",
        range_middle: "[&>button]:bg-ink/10",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        // v8 had IconLeft and IconRight. v10 asks one component which way it is pointing.
        Chevron: ({ orientation, className, ...props }) =>
          orientation === "left"
            ? <ChevronLeft className={cn("h-4 w-4", className)} {...props} />
            : <ChevronRight className={cn("h-4 w-4", className)} {...props} />,
      }}
      {...props} />
  );
}
Calendar.displayName = "Calendar"

export { Calendar }
