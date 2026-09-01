import React, { useState } from "react";
import { format } from "date-fns";
import { Calendar as CalendarIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Calendar } from "./calendar";

/** Button that opens a calendar + time popover; stores/returns an ISO string
 * to match the backend's `starts_at`/`ends_at`/`doors_open_at` fields.
 *
 * The popover is sized and layered deliberately. Inside a tier card these pickers sit in
 * a four-column grid, and the panel was inheriting that narrow column: the calendar grid
 * was clipped and the time input sat below the fold of the popover, so setting a tier's
 * sale window meant scrolling inside a box most people did not realise scrolled. It now
 * states its own width, floats above the form rather than inside its stacking context,
 * and shows the chosen value in full at the top so the time is readable without hunting
 * for the input that set it.
 */
/** Read a stored value into a Date, in local time.
 *
 * A bare "2026-08-15" is parsed by `new Date` as UTC midnight, so west of Greenwich it
 * renders as the 14th — the same trap the album date label had to avoid. Date-only
 * values are therefore taken apart by hand; full ISO timestamps carry an offset and are
 * safe to hand over as they are.
 */
const parseValue = (value) => {
  if (!value) return undefined;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

const asDayString = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * `mode` picks what a field is actually asking for.
 *
 *   "datetime" — a moment. Emits an ISO timestamp; the popover carries a time row.
 *   "date"     — a day. Emits "YYYY-MM-DD"; no time row, and the trigger draws one line.
 *
 * The date mode exists so that every date field in the admin can share this calendar.
 * The ones that did not were native `<input type="date">`s, which render the operating
 * system's own picker — a different typeface, a different palette and a different set of
 * navigation controls sitting inside a deliberately austere admin. Giving them a time to
 * set they do not have would have been the other wrong answer.
 */
export function DateTimePicker({ value, onChange, placeholder, mode = "datetime" }) {
  const dateOnly = mode === "date";
  const date = parseValue(value);
  const [open, setOpen] = useState(false);
  const hint = placeholder || (dateOnly ? "Pick a date" : "Pick date & time");

  const emit = (d) => onChange(dateOnly ? asDayString(d) : d.toISOString());

  const setDatePart = (d) => {
    if (!d) return;
    const next = date ? new Date(date) : new Date();
    next.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
    emit(next);
    // A day has nothing further to set, so the popover has no reason to stay open.
    if (dateOnly) setOpen(false);
  };

  const setTimePart = (timeStr) => {
    const [h, m] = timeStr.split(":").map(Number);
    const next = date ? new Date(date) : new Date();
    next.setHours(h || 0, m || 0, 0, 0);
    emit(next);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" data-testid="datetime-trigger"
                className="input-x w-full flex items-center justify-between gap-2 text-left min-w-0">
          {/* Two lines rather than one truncated one: in a narrow column the single line
              cut the time off, which is the half most often being checked.
              Both lines are always rendered, even with nothing chosen. An empty field
              used to draw one line and a filled one two, so Starts, Ends and Doors sat
              side by side at different heights whenever one of them was blank — which
              Doors usually is. */}
          <span className={`min-w-0 ${date ? "" : "text-ink-4"}`}>
            <span className="block truncate">{date ? format(date, "d MMM yyyy") : hint}</span>
            {/* Only where there is a time to show. The second line exists to keep Starts,
                Ends and Doors level with each other; a lone date field has nothing to
                stay level with, and an empty "--:--" under it would promise a control
                the popover does not offer. */}
            {!dateOnly && (
              <span className="block font-mono-x text-[10px] tracking-[0.2em] text-ink-3">
                {date ? format(date, "HH:mm") : "--:--"}
              </span>
            )}
          </span>
          <CalendarIcon size={14} className="text-ink-4 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        collisionPadding={12}
        data-testid="datetime-popover"
        // z-50 keeps it over the event form's own overlay; the explicit width stops the
        // calendar being squeezed into the grid column the trigger happens to sit in.
        className="z-50 w-[19rem] max-w-[calc(100vw-1.5rem)] p-0 bg-surface border border-ink/20 text-ink shadow-2xl"
      >
        {/* No readout row. It restated "EEE d MMM yyyy · HH:mm" directly above a calendar
            with that day already highlighted and a time input holding that time, so it
            was the third copy of the same fact and the only one nobody could act on. */}
        {/* defaultMonth, or the calendar opens on the current month even when the field
            already holds a date — someone checking a sale window set for December was
            shown August and had to page back to see what they came to look at. */}
        <Calendar mode="single" selected={date} defaultMonth={date} onSelect={setDatePart} autoFocus />
        {!dateOnly && (
          <div className="p-3 border-t border-ink/10 flex items-center gap-2">
            <span className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 shrink-0">Time</span>
            <input type="time" value={date ? format(date, "HH:mm") : ""} data-testid="datetime-time"
                   onChange={(e) => setTimePart(e.target.value)} className="input-x flex-1 !py-1.5" />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
