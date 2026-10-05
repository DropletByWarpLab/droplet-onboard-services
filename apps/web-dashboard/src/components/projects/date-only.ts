// WARP-3372 — dueDate / startDate are CALENDAR DATES, not instants.
//
// "Due 25 June" is the same day in Los Angeles and in Auckland. The orchestrator
// stores a date as that day at 00:00:00Z and speaks `YYYY-MM-DD` on the wire, so
// the date a person typed is a plain string with no zone in it. Run it through
// `new Date(...)` and read the local getters and it stops being one: west of UTC
// the stored midnight is the previous evening, and the day comes back one early.
//
// So this is the ONE place the Projects surface turns a date value into
// something it shows or compares, and it never builds a `Date` from one:
//
//   - reading a date  → slice the `YYYY-MM-DD` out of the string;
//   - "today"         → the viewer's own calendar day (local getters on an
//                       instant that really is "now", the one legitimate use);
//   - "overdue"       → one `YYYY-MM-DD` string compared to another.
//
// A response from before date-only still reaches here as `…T00:00:00.000Z`; its
// leading date is the day it was stored as, so it reads correctly too.

const LEADING_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The calendar date a wire value stands for, as `YYYY-MM-DD` — or null when it
 * is empty or not a date, so the UI shows a dash instead of "NaN".
 */
export function dateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = LEADING_DATE.exec(value);
  if (!m) return null;
  const [month, day] = [Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** `2026-06-25` → `Jun 25`. Null-safe. */
export function formatDayMonth(value: string | null | undefined): string | null {
  const d = dateOnly(value);
  if (!d) return null;
  return `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
}

/** The viewer's own calendar day as `YYYY-MM-DD` — their local date, which is
 *  the day "overdue" and "due today" mean to them. */
export function localToday(now: Date = new Date()): string {
  const y = String(now.getFullYear()).padStart(4, "0");
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Is the date strictly before the viewer's today? Due today is not overdue. */
export function isBeforeToday(value: string | null | undefined, now: Date = new Date()): boolean {
  const d = dateOnly(value);
  // ISO calendar dates order lexicographically.
  return d !== null && d < localToday(now);
}
