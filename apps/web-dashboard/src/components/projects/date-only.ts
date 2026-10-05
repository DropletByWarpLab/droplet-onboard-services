// Calendar dates for the planning surfaces (WARP-3521, WARP-3520). A date such
// as "2026-10-05" is the same day in every viewer's timezone, so it must never
// be turned into a local instant for display or comparison. `localToday` is the
// only intentional local-clock read: it answers what day it is for this viewer.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LEADING_DATE = /^(\d{4}-\d{2}-\d{2})(?:$|T)/;

export interface DateParts {
  y: number;
  m: number;
  d: number;
}

/** `YYYY-MM-DD` → its parts, or null for anything that is not a real date. */
export function parseDateOnly(value: string | null | undefined): DateParts | null {
  if (!value) return null;
  const match = DATE_ONLY.exec(value);
  if (!match) return null;
  const parts = { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
  // Date.UTC remaps years 0000–0099 to 1900–1999. setUTCFullYear preserves them.
  const probe = new Date(0);
  probe.setUTCHours(0, 0, 0, 0);
  probe.setUTCFullYear(parts.y, parts.m - 1, parts.d);
  if (
    probe.getUTCFullYear() !== parts.y ||
    probe.getUTCMonth() !== parts.m - 1 ||
    probe.getUTCDate() !== parts.d
  ) {
    return null;
  }
  return parts;
}

/** A date-only wire value or legacy midnight-UTC timestamp → `YYYY-MM-DD`. */
export function dateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = LEADING_DATE.exec(value);
  if (!match || !parseDateOnly(match[1])) return null;
  return match[1];
}

/** "Oct 5". Null-safe: an invalid value is a dash, never "NaN". */
export function fmtDay(value: string | null | undefined): string {
  const parts = parseDateOnly(value);
  return parts ? `${MONTHS[parts.m - 1]} ${parts.d}` : "—";
}

/** `2026-06-25` → `Jun 25`. */
export function formatDayMonth(value: string | null | undefined): string | null {
  const day = dateOnly(value);
  if (!day) return null;
  return `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
}

/** "Oct 5, 2026". */
export function fmtDayYear(value: string | null | undefined): string {
  const parts = parseDateOnly(value);
  return parts ? `${MONTHS[parts.m - 1]} ${parts.d}, ${parts.y}` : "—";
}

/** "Oct 5 – Oct 16", or the known date in the owner's words. */
export function fmtRange(start: string | null | undefined, end: string | null | undefined): string {
  const s = parseDateOnly(start);
  const e = parseDateOnly(end);
  if (s && e) return `${fmtDay(start)} – ${fmtDay(end)}`;
  if (s) return `Starts ${fmtDay(start)}`;
  if (e) return `Ends ${fmtDay(end)}`;
  return "No dates set";
}

/** The viewer's own calendar day as `YYYY-MM-DD`. */
export function localToday(now: Date = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Whole calendar days from `a` to `b` (negative when `b` is earlier). */
export function dayDiff(a: string, b: string): number {
  const from = parseDateOnly(a);
  const to = parseDateOnly(b);
  if (!from || !to) return Number.NaN;
  const utcDay = ({ y, m, d }: DateParts) => {
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(y, m - 1, d);
    return date.getTime();
  };
  return Math.round((utcDay(to) - utcDay(from)) / 86_400_000);
}

/** Is the date strictly before the viewer's today? Due today is not overdue. */
export function isBeforeToday(value: string | null | undefined, now: Date = new Date()): boolean {
  const day = dateOnly(value);
  return day !== null && day < localToday(now);
}

/** "5 days left", "Ends today", "Ended yesterday" — against the viewer's day. */
export function daysLeftLabel(end: string | null | undefined, today: string = localToday()): string | null {
  if (!end) return null;
  const days = dayDiff(today, end);
  if (Number.isNaN(days)) return null;
  if (days > 1) return `${days} days left`;
  if (days === 1) return "1 day left";
  if (days === 0) return "Ends today";
  if (days === -1) return "Ended yesterday";
  return `Ended ${-days} days ago`;
}
