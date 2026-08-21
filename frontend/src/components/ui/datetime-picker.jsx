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
export function DateTimePicker({ value, onChange, placeholder = "Pick date & time" }) {
  const date = value ? new Date(value) : undefined;
  const [open, setOpen] = useState(false);

  const setDatePart = (d) => {
    if (!d) return;
    const next = date ? new Date(date) : new Date();
    next.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
    onChange(next.toISOString());
  };

  const setTimePart = (timeStr) => {
    const [h, m] = timeStr.split(":").map(Number);
    const next = date ? new Date(date) : new Date();
    next.setHours(h || 0, m || 0, 0, 0);
    onChange(next.toISOString());
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
            <span className="block truncate">{date ? format(date, "d MMM yyyy") : placeholder}</span>
            <span className="block font-mono-x text-[10px] tracking-[0.2em] text-ink-3">
              {date ? format(date, "HH:mm") : "--:--"}
            </span>
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
        <div className="p-3 border-t border-ink/10 flex items-center gap-2">
          <span className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 shrink-0">Time</span>
          <input type="time" value={date ? format(date, "HH:mm") : ""} data-testid="datetime-time"
                 onChange={(e) => setTimePart(e.target.value)} className="input-x flex-1 !py-1.5" />
        </div>
      </PopoverContent>
    </Popover>
  );
}
