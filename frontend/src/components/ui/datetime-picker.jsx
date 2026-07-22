import React, { useState } from "react";
import { format } from "date-fns";
import { Calendar as CalendarIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Calendar } from "./calendar";

/** Button that opens a calendar + time popover; stores/returns an ISO string
 * to match the backend's `starts_at`/`ends_at`/`doors_open_at` fields. */
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
        <button type="button" className="input-x w-full flex items-center justify-between gap-2 text-left min-w-0">
          <span className={`truncate ${date ? "" : "text-zinc-500"}`}>
            {date ? format(date, "d MMM yyyy, HH:mm") : placeholder}
          </span>
          <CalendarIcon size={14} className="text-zinc-500 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0 bg-[#0F0F0F] border-white/20 text-white">
        <Calendar mode="single" selected={date} onSelect={setDatePart} initialFocus />
        <div className="p-3 border-t border-white/10">
          <input type="time" value={date ? format(date, "HH:mm") : ""} onChange={(e) => setTimePart(e.target.value)} className="input-x w-full" />
        </div>
      </PopoverContent>
    </Popover>
  );
}
