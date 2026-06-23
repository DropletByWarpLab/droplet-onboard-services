"use client";

/**
 * Calendar UX clarity (Samantha QA #bugs) — a date input paired with a
 * 15-minute-increment time dropdown, replacing the opaque native
 * `datetime-local` control on EventForm (Starts / Ends) and RemindersPanel
 * (Due).
 *
 * Contract (unchanged from the native control it replaces): `value` and the
 * `onChange` payload are a `YYYY-MM-DDTHH:mm` **local** string with no timezone
 * suffix — exactly what EventForm's isoToLocalInput / localInputToIso and the
 * duration-slide logic in handleStartChange already round-trip. The picker is a
 * pure presentation swap; the stored ISO value is untouched.
 *
 * The two parts are held in local state so the user can pick a date before a
 * time (and vice-versa) without the half-filled value leaking out as a
 * malformed string. onChange fires only once both parts are present. When the
 * parent pushes a new complete `value` (e.g. the end time sliding to follow the
 * start), the parts re-sync from it.
 */

import { useEffect, useId, useState } from "react";
import {
  splitLocalInput,
  joinLocalInput,
  quarterHourOptions,
  snapTimeToQuarter,
  type TimeOption,
} from "@/components/calendar/datetime-picker-helpers";

interface Props {
  /** `YYYY-MM-DDTHH:mm` local-input string (no TZ suffix), or "". */
  value: string;
  onChange: (next: string) => void;
  /** Accessible label stem, e.g. "Starts" → "Starts date" / "Starts time". */
  label: string;
  disabled?: boolean;
}

// Computed once: the grid never changes between renders.
const TIME_OPTIONS: TimeOption[] = quarterHourOptions();

export function DateTimePicker({ value, onChange, label, disabled }: Props) {
  const parts = splitLocalInput(value);
  const [date, setDate] = useState(parts.date);
  // Snap any carried-over off-grid time onto the dropdown grid so the <select>
  // always has a matching option (otherwise it would render blank).
  const [time, setTime] = useState(snapTimeToQuarter(parts.time));

  // Re-sync from the parent whenever it pushes a new complete value (the
  // start/end duration slide, opening the form on an existing event, …).
  useEffect(() => {
    const next = splitLocalInput(value);
    setDate(next.date);
    setTime(snapTimeToQuarter(next.time));
  }, [value]);

  const baseId = useId();
  const dateId = `${baseId}-date`;
  const timeId = `${baseId}-time`;

  function emit(nextDate: string, nextTime: string) {
    setDate(nextDate);
    setTime(nextTime);
    const joined = joinLocalInput(nextDate, nextTime);
    // Only surface a fully-formed value; never leak a half-built string.
    if (joined) onChange(joined);
  }

  return (
    <div className="flex gap-2">
      <input
        id={dateId}
        type="date"
        aria-label={`${label} date`}
        value={date}
        disabled={disabled}
        onChange={(e) => emit(e.target.value, time)}
        className="dp-input flex-1 min-w-0"
      />
      <select
        id={timeId}
        aria-label={`${label} time`}
        value={time}
        disabled={disabled}
        onChange={(e) => emit(date, e.target.value)}
        className="dp-input w-auto shrink-0"
      >
        {/* A blank placeholder slot while no time is chosen yet. */}
        {!time && <option value="" />}
        {TIME_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
