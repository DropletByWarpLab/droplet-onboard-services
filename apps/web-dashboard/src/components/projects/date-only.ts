// Calendar dates for the planning surfaces (WARP-3521).
//
// A cycle's start and end and a module's start and target are CALENDAR dates:
// the API answers them as `YYYY-MM-DD` and they mean the same day for everyone.
// Pushing one through `new Date("2026-10-05")` reads it as midnight UTC and then
// formats it in the viewer's zone, which puts it on the 4th for anyone west of
// UTC (WARP-3372). Everything here works on the year / month / day parts and
// never builds an instant out of a date-only string, so there is no zone to be
// wrong in. The one place a clock is read is `localToday`, and it reads the
// viewer's own calendar day on purpose — "ends today" is a question about the
// day on the viewer's wall.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface DateParts {
  y: number;
  m: number; // 1-12
  d: number;
}

/** `YYYY-MM-DD` → its parts, or null for anything that is not a real calendar date. */
export function parseDateOnly(value: string | null | undefined): DateParts | null {
  if (!value) return null;
  const m = DATE_ONLY.exec(value);
  if (!m) return null;
  const parts = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  // Date.UTC rolls 2026-02-30 into March; a real date survives the round trip.
  const probe = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  if (
    probe.getUTCFullYear() !== parts.y ||
    probe.getUTCMonth() !== parts.m - 1 ||
    probe.getUTCDate() !== parts.d
  ) {
    return null;
  }
  return parts;
}

/** "Oct 5". Null-safe: an unparseable value is "—", never "NaN" or "Invalid Date". */
export function fmtDay(value: string | null | undefined): string {
  const p = parseDateOnly(value);
  return p ? `${MONTHS[p.m - 1]} ${p.d}` : "—";
}

/** "Oct 5, 2026". */
export function fmtDayYear(value: string | null | undefined): string {
  const p = parseDateOnly(value);
  return p ? `${MONTHS[p.m - 1]} ${p.d}, ${p.y}` : "—";
}

/** "Oct 5 – Oct 16", or what is known, in the owner's words. */
export function fmtRange(start: string | null | undefined, end: string | null | undefined): string {
  const s = parseDateOnly(start);
  const e = parseDateOnly(end);
  if (s && e) return `${fmtDay(start)} – ${fmtDay(end)}`;
  if (s) return `Starts ${fmtDay(start)}`;
  if (e) return `Ends ${fmtDay(end)}`;
  return "No dates set";
}

/** The viewer's own calendar day, as `YYYY-MM-DD`. */
export function localToday(now: Date = new Date()): string {
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${mm}-${dd}`;
}

/** Whole calendar days from `a` to `b` (negative when `b` is earlier). NaN if either is not a date. */
export function dayDiff(a: string, b: string): number {
  const pa = parseDateOnly(a);
  const pb = parseDateOnly(b);
  if (!pa || !pb) return Number.NaN;
  const ms = Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d);
  return Math.round(ms / 86_400_000);
}

/** "5 days left", "1 day left", "Ends today", "Ended 2 days ago" — against `today`. */
export function daysLeftLabel(end: string | null | undefined, today: string = localToday()): string | null {
  if (!end) return null;
  const n = dayDiff(today, end);
  if (Number.isNaN(n)) return null;
  if (n > 1) return `${n} days left`;
  if (n === 1) return "1 day left";
  if (n === 0) return "Ends today";
  if (n === -1) return "Ended yesterday";
  return `Ended ${-n} days ago`;
}
