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
 * time (and vice-versa) without a malformed string leaking out. onChange fires
 * with "" when either part is empty (propagating a clear to the parent), and
 * with a full "YYYY-MM-DDTHH:mm" string once both parts are present. When the
 * parent pushes a new complete `value` (e.g. the end time sliding to follow the
 * start), the parts re-sync from it — and if the time is off-grid the snap is
 * propagated back via onChange so the parent's stored value matches the display.
 */

import { useEffect, useId, useState } from "react";
import {
  splitLocalInput,
  joinLocalInput,
  quarterHourOptions,
  quarterHourOptionsForDevice,
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

// Computed once: the grid never changes between renders. Pinned to en-GB so
// the server pre-render and the first client render agree (see helpers).
const TIME_OPTIONS: TimeOption[] = quarterHourOptions();

export function DateTimePicker({ value, onChange, label, disabled }: Props) {
  const parts = splitLocalInput(value);
  // WARP-1793: the dropdown used to show the pinned 24-hour labels forever, so
  // a US phone read "09:45"/"14:30" with no AM/PM. We cannot localize during
  // SSR — the server does not know the visitor's clock — so we render the
  // pinned labels once (matching the server byte-for-byte, no hydration
  // mismatch) and swap to the device's own format immediately after mount.
  // Only `label` changes; `value` stays the machine `HH:mm`, so the selected
  // option and every onChange payload are unaffected by the swap.
  const [timeOptions, setTimeOptions] = useState<TimeOption[]>(TIME_OPTIONS);
  useEffect(() => {
    setTimeOptions(quarterHourOptionsForDevice());
  }, []);
  const [date, setDate] = useState(parts.date);
  // Snap any carried-over off-grid time onto the dropdown grid so the <select>
  // always has a matching option (otherwise it would render blank).
  const [time, setTime] = useState(snapTimeToQuarter(parts.time));

  // Re-sync from the parent whenever it pushes a new complete value (the
  // start/end duration slide, opening the form on an existing event, …).
  // If the incoming time is off the 15-min grid, snap it and notify the parent
  // so the stored ISO matches what the dropdown displays.
  useEffect(() => {
    const next = splitLocalInput(value);
    setDate(next.date);
    const snapped = snapTimeToQuarter(next.time);
    setTime(snapped);
    const joined = joinLocalInput(next.date, snapped);
    if (joined && joined !== value) onChange(joined);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const baseId = useId();
  const dateId = `${baseId}-date`;
  const timeId = `${baseId}-time`;

  function emit(nextDate: string, nextTime: string) {
    setDate(nextDate);
    setTime(nextTime);
    // "" when a field is empty — propagates a clear so the parent doesn't
    // retain a stale complete value.
    onChange(joinLocalInput(nextDate, nextTime));
  }

  return (
    // WARP-1152: flex-wrap lets the time dropdown fall onto its own line when
    // the available column is narrower than date-floor + gap + time-intrinsic
    // (~250px — e.g. one half of EventForm's sm:grid-cols-2 split inside the
    // max-w-md dialog). Without it the row's min-content width overflowed the
    // dialog's content box and grew an internal horizontal scrollbar.
    <div className="flex flex-wrap gap-2">
      <input
        id={dateId}
        type="date"
        aria-label={`${label} date`}
        value={date}
        disabled={disabled}
        onChange={(e) => emit(e.target.value, time)}
        // WARP-943: min-w-0 let flexbox shrink below MM/DD/YYYY+icon; 8.5rem floor keeps the year visible.
        className="flex-1 min-w-[8.5rem] outline-none focus:border-[var(--brand)]"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-input)",
          color: "var(--text)",
          padding: "6px 10px",
        }}
      />
      <select
        id={timeId}
        aria-label={`${label} time`}
        value={time}
        disabled={disabled}
        onChange={(e) => emit(date, e.target.value)}
        className="w-auto shrink-0 outline-none focus:border-[var(--brand)]"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-input)",
          color: "var(--text)",
          padding: "6px 10px",
        }}
      >
        {/* A blank placeholder slot while no time is chosen yet. */}
        {!time && <option value="" />}
        {timeOptions.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
