// Calendar-date ("date-only") arithmetic for the Projects scheduling views —
// WARP-3523 (calendar, timeline, My Work).
//
// `dueDate` / `startDate` are CALENDAR DATES: "Oct 3" is Oct 3 on every
// viewer's wall calendar. They are carried as `YYYY-MM-DD` strings and the
// arithmetic here is integer math on a day number — no `Date` object is ever
// built from a date-only value, so neither the viewer's time zone nor a DST
// transition (23- and 25-hour days) can move a date. That is the whole point:
// `new Date("2026-10-03")` is UTC midnight, and every local-time getter on it
// (`getDate`, `getMonth`) answers Oct 2 anywhere west of Greenwich.
//
// The one place local time legitimately appears is `todayLocal`: "today" is the
// viewer's wall-calendar day, read from a real instant.
//
// Reading a wire value and "today" are WS-1's (WARP-3372) shared helper,
// `../date-only` — copied here verbatim so the two slices agree on both. What
// this file adds on top is arithmetic, validation, formatting and the PATCH wire
// form, which the board and list do not need.

/** A calendar date, `YYYY-MM-DD`. Lexicographic order == chronological order. */
import { dateOnly, localToday } from "../date-only";

export type DateOnly = string;

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The years a calendar date may have. A four-digit year is a real date to the
 * calendar ("0002-10-20" exists), but nobody schedules work there: a segmented
 * date control reports it while a person is still typing the year, and the API
 * would store it. Bounding it here keeps a keystroke from becoming a date.
 */
export const MIN_YEAR = 1900;
export const MAX_YEAR = 2200;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(year: number, month1: number): number {
  return month1 === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month1 - 1];
}

/**
 * True for a well-formed, REAL calendar date (`2026-02-30` is not). Deliberately
 * not a type predicate: `DateOnly` is a plain `string`, and a predicate would
 * narrow the failing branch of a `string` to `never`.
 */
export function isDateOnly(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const m = DATE_ONLY_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(Number(m[1]), month);
}

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function parts(d: DateOnly): Ymd {
  return { y: Number(d.slice(0, 4)), m: Number(d.slice(5, 7)), d: Number(d.slice(8, 10)) };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function format({ y, m, d }: Ymd): DateOnly {
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

// Howard Hinnant's civil-calendar algorithms: days since 1970-01-01 <-> y/m/d,
// pure integer math over the proleptic Gregorian calendar.
function toDayNumber({ y, m, d }: Ymd): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function fromDayNumber(n: number): Ymd {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

/**
 * The window a person could plausibly mean when they pick a date to schedule
 * work on: five years back to twenty ahead of `today`, inside the hard bounds
 * above. The date control uses it to refuse `0002-10-20` and `0202-10-20`, the
 * intermediate values a segmented input reports on the way to `2026-10-20`.
 */
export function plausibleScheduleRange(today: DateOnly): { min: DateOnly; max: DateOnly } {
  const year = Number(today.slice(0, 4));
  const pad = (y: number) => String(Math.min(MAX_YEAR, Math.max(MIN_YEAR, y))).padStart(4, "0");
  return { min: `${pad(year - 5)}-01-01`, max: `${pad(year + 20)}-12-31` };
}

export function isPlausibleScheduleDate(value: string, today: DateOnly): boolean {
  if (!isDateOnly(value)) return false;
  const { min, max } = plausibleScheduleRange(today);
  return value >= min && value <= max;
}

/** Days since 1970-01-01 (negative before). The unit every helper below works in. */
export function dayNumber(d: DateOnly): number {
  return toDayNumber(parts(d));
}

export function fromDayNum(n: number): DateOnly {
  return format(fromDayNumber(n));
}

/** `to - from` in whole days. */
export function diffDays(from: DateOnly, to: DateOnly): number {
  return dayNumber(to) - dayNumber(from);
}

export function addDays(d: DateOnly, n: number): DateOnly {
  return fromDayNum(dayNumber(d) + Math.trunc(n));
}

export function compareDateOnly(a: DateOnly, b: DateOnly): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a: DateOnly, b: DateOnly): DateOnly {
  return a <= b ? a : b;
}

export function maxDate(a: DateOnly, b: DateOnly): DateOnly {
  return a >= b ? a : b;
}

/** Inclusive `[from, to]` list. `from > to` is empty; `max` bounds a runaway range. */
export function eachDay(from: DateOnly, to: DateOnly, max = 1500): DateOnly[] {
  const out: DateOnly[] = [];
  const end = dayNumber(to);
  for (let n = dayNumber(from); n <= end && out.length < max; n += 1) out.push(fromDayNum(n));
  return out;
}

/** 0 = Sunday … 6 = Saturday. 1970-01-01 was a Thursday. */
export function weekdayOf(d: DateOnly): Weekday {
  return ((((dayNumber(d) % 7) + 7) + 4) % 7) as Weekday;
}

/** The first day of the week containing `d` (`weekStart` 0 = Sunday, 1 = Monday). */
export function startOfWeek(d: DateOnly, weekStart: Weekday = 0): DateOnly {
  const back = (weekdayOf(d) - weekStart + 7) % 7;
  return addDays(d, -back);
}

export function startOfMonth(d: DateOnly): DateOnly {
  return `${d.slice(0, 7)}-01`;
}

export function endOfMonth(d: DateOnly): DateOnly {
  const { y, m } = parts(d);
  return format({ y, m, d: daysInMonth(y, m) });
}

/** Shift by whole months, clamping the day to the target month's length (Jan 31 + 1 = Feb 28/29). */
export function addMonths(d: DateOnly, n: number): DateOnly {
  const { y, m, d: day } = parts(d);
  const index = y * 12 + (m - 1) + Math.trunc(n);
  const ny = Math.floor(index / 12);
  const nm = index - ny * 12 + 1;
  return format({ y: ny, m: nm, d: Math.min(day, daysInMonth(ny, nm)) });
}

export function monthOf(d: DateOnly): string {
  return d.slice(0, 7);
}

export function yearOf(d: DateOnly): number {
  return Number(d.slice(0, 4));
}

/** 1..12 */
export function monthNumberOf(d: DateOnly): number {
  return Number(d.slice(5, 7));
}

export function dayOfMonth(d: DateOnly): number {
  return Number(d.slice(8, 10));
}

/** The viewer's wall-calendar day — WS-1's `localToday`, the one local-time read. */
export function todayLocal(now: Date = new Date()): DateOnly {
  return localToday(now);
}

/**
 * Wire value -> calendar date. WS-1's `dateOnly` reads the leading `YYYY-MM-DD`
 * of what the PM API emits today (an ISO datetime stored at 00:00:00Z) and of
 * what it emits once WS-1 lands (`YYYY-MM-DD`) — never through `Date`. On top of
 * that, a date that does not exist (`2026-02-30`) is null here, so it can never
 * be placed on a day it is not.
 */
export function parseDateOnly(value: string | null | undefined): DateOnly | null {
  const d = dateOnly(value);
  return d !== null && isDateOnly(d) ? d : null;
}

/**
 * Calendar date -> the string `PATCH /api/pm/work-items/:id` accepts for
 * `start_date` / `due_date` (`z.string().datetime()` — a full ISO datetime with
 * `Z`). The stored value is `DateTime` at 00:00:00Z, so this is exactly what the
 * existing new-item modal sends. If the wire contract becomes date-only, this is
 * the single line to change.
 */
export function toWireDate(d: DateOnly): string {
  return `${d}T00:00:00.000Z`;
}

/**
 * Human label for a calendar date. Formats a UTC-pinned instant at noon, so the
 * runtime's zone cannot move it. `style` picks a preset; pass `locale` in tests.
 */
export type DayStyle = "short" | "long" | "weekday" | "monthYear" | "month";

const STYLE_OPTIONS: Record<DayStyle, Intl.DateTimeFormatOptions> = {
  short: { month: "short", day: "numeric" },
  long: { month: "short", day: "numeric", year: "numeric" },
  weekday: { weekday: "long", month: "long", day: "numeric" },
  monthYear: { month: "long", year: "numeric" },
  month: { month: "short" },
};

export function formatDay(d: DateOnly, style: DayStyle = "short", locale?: string): string {
  const { y, m, d: day } = parts(d);
  const at = new Date(0);
  at.setUTCFullYear(y, m - 1, day);
  at.setUTCHours(12, 0, 0, 0);
  return new Intl.DateTimeFormat(locale, { ...STYLE_OPTIONS[style], timeZone: "UTC" }).format(at);
}

/** Short weekday name ("Mon") of a calendar date. */
export function weekdayShort(d: DateOnly, locale?: string): string {
  const at = new Date(0);
  const { y, m, d: day } = parts(d);
  at.setUTCFullYear(y, m - 1, day);
  at.setUTCHours(12, 0, 0, 0);
  return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(at);
}
