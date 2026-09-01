import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { DayPicker } from "react-day-picker"
import { addMonths, addYears, format, setMonth, setYear, startOfMonth } from "date-fns"

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

/** How many years either side of the middle one the year view offers. */
const YEAR_RADIUS = 5;

/** The three things the panel can be showing. Days is where it opens; the other two are
 * steps on the way back down to a day. */
const DAYS = "days";
const MONTHS = "months";
const YEARS = "years";

/** Shared look for the month and year buttons, so the two grids read as one control. */
const cellClass = cn(
  buttonVariants({ variant: "ghost" }),
  "h-9 w-full px-0 font-normal text-sm hover:bg-ink hover:text-page focus:bg-ink focus:text-page"
);
const cellCurrent = "border border-ink/30";
const cellChosen = "bg-ink text-page hover:bg-ink hover:text-page";

/** The header the drill-down hangs off: a chevron each side, and a month and a year that
 * are each a button rather than one inert label.
 *
 * DayPicker draws a caption and a nav of its own; both are hidden below and replaced by
 * this. Reaching in through v10's `components.MonthCaption` would have worked too, and
 * would have tied the whole feature to the shape of one internal prop bag — the exact
 * kind of coupling the rename notes above are a monument to. */
function Header({ month, view, onPrev, onNext, onMonthClick, onYearClick }) {
  const label = view === YEARS
    ? `${month.getFullYear() - YEAR_RADIUS} – ${month.getFullYear() + YEAR_RADIUS}`
    : null;
  // The chevrons move by whatever the grid below them is made of, so they say so. A
  // button labelled "previous month" that steps back eleven years is worse to a screen
  // reader than an unlabelled one, because it is confidently wrong.
  const unit = view === DAYS ? "month" : view === MONTHS ? "year" : "years";
  return (
    <div className="flex h-7 items-center justify-between gap-1">
      <button type="button" onClick={onPrev} data-testid="calendar-prev" aria-label={`Previous ${unit}`}
              className={cn(buttonVariants({ variant: "outline" }), "h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100")}>
        <ChevronLeft className="h-4 w-4" />
      </button>
      <div className="flex items-center gap-1 text-sm font-medium">
        {label ? (
          <span data-testid="calendar-range-label">{label}</span>
        ) : (
          <>
            {/* Hidden in the month view rather than removed, so the year stays put
                instead of sliding to the middle the moment you open the months. */}
            <button type="button" onClick={onMonthClick} data-testid="calendar-month-label"
                    className={cn("px-1 hover:underline", view === MONTHS && "invisible")}>
              {format(month, "MMMM")}
            </button>
            <button type="button" onClick={onYearClick} data-testid="calendar-year-label"
                    className="px-1 hover:underline">
              {format(month, "yyyy")}
            </button>
          </>
        )}
      </div>
      <button type="button" onClick={onNext} data-testid="calendar-next" aria-label={`Next ${unit}`}
              className={cn(buttonVariants({ variant: "outline" }), "h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100")}>
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}

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
  month: monthProp,
  defaultMonth,
  onMonthChange,
  selected,
  ...props
}) {
  const [view, setView] = React.useState(DAYS);
  // Seeded the way an uncontrolled DayPicker seeds itself, so a field already holding a
  // date still opens on that date's month rather than on today.
  const [monthState, setMonthState] = React.useState(
    () => startOfMonth(monthProp || defaultMonth || selected || new Date())
  );
  const month = monthProp ? startOfMonth(monthProp) : monthState;

  const goTo = (next) => {
    setMonthState(startOfMonth(next));
    onMonthChange?.(startOfMonth(next));
  };

  // One chevron pair, three meanings: a month at a time on the day grid, a year at a
  // time on the months, and a whole window of years on the years — always the unit the
  // grid under it is made of.
  const step = (dir) => {
    if (view === DAYS) return goTo(addMonths(month, dir));
    if (view === MONTHS) return goTo(addYears(month, dir));
    return goTo(addYears(month, dir * (YEAR_RADIUS * 2 + 1)));
  };

  const chosen = selected instanceof Date ? selected : undefined;
  const today = new Date();
  const years = Array.from({ length: YEAR_RADIUS * 2 + 1 }, (_, i) => month.getFullYear() - YEAR_RADIUS + i);

  return (
    <div className={cn("p-3 flex flex-col gap-4", className)} data-testid="calendar">
      <Header
        month={month}
        view={view}
        onPrev={() => step(-1)}
        onNext={() => step(1)}
        onMonthClick={() => setView(MONTHS)}
        onYearClick={() => setView(YEARS)}
      />

      {view === DAYS && (
        <DayPicker
          showOutsideDays={showOutsideDays}
          fixedWeeks={fixedWeeks}
          // The header above IS the navigation. Hiding v10's own with a class would
          // have left it in the DOM — a second, invisible "previous month" button that
          // a screen reader still reaches and a test still finds.
          hideNavigation
          month={month}
          onMonthChange={goTo}
          selected={selected}
          classNames={{
            months: "flex flex-col sm:flex-row gap-4",
            month: "flex flex-col",
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
            // selector each rather than spread across day_button, which cannot know
            // whether its own cell is selected.
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
            // Removed outright, not styled away: the month and year in the header are
            // buttons, and a second static copy of the same words directly above the
            // grid is one an editor would reasonably try to click.
            MonthCaption: () => null,
            // v8 had IconLeft and IconRight. v10 asks one component which way it is
            // pointing. Kept even with the nav hidden, so anything that renders a
            // chevron still gets this app's icon set rather than v10's default.
            Chevron: ({ orientation, className, ...rest }) =>
              orientation === "left"
                ? <ChevronLeft className={cn("h-4 w-4", className)} {...rest} />
                : <ChevronRight className={cn("h-4 w-4", className)} {...rest} />,
          }}
          {...props} />
      )}

      {/* Both step grids are three columns and four rows tall, which is close enough to
          the six-week day grid that the popover does not jump as you drill down. */}
      {view === MONTHS && (
        <div className="grid grid-cols-3 gap-1 min-h-[15.5rem] content-start" data-testid="calendar-months">
          {Array.from({ length: 12 }, (_, m) => (
            <button
              key={m} type="button" data-testid={`calendar-month-${m}`}
              onClick={() => { goTo(setMonth(month, m)); setView(DAYS); }}
              className={cn(
                cellClass,
                chosen && chosen.getFullYear() === month.getFullYear() && chosen.getMonth() === m && cellChosen,
                today.getFullYear() === month.getFullYear() && today.getMonth() === m && cellCurrent,
              )}>
              {format(setMonth(month, m), "MMM")}
            </button>
          ))}
        </div>
      )}

      {view === YEARS && (
        <div className="grid grid-cols-3 gap-1 min-h-[15.5rem] content-start" data-testid="calendar-years">
          {years.map((y) => (
            <button
              key={y} type="button" data-testid={`calendar-year-${y}`}
              // Down to the months, not straight back to the days: picking 2019 says
              // which year, and the month it should land on is the next question, not
              // one to answer on the reader's behalf with whichever month was showing.
              onClick={() => { goTo(setYear(month, y)); setView(MONTHS); }}
              className={cn(
                cellClass,
                chosen && chosen.getFullYear() === y && cellChosen,
                today.getFullYear() === y && cellCurrent,
              )}>
              {y}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
Calendar.displayName = "Calendar"

export { Calendar }
