/**
 * Business time (ADR-069 §6, WARP-3530) — how many working minutes lie between
 * two instants, and the instant a number of working minutes from now falls on.
 *
 * ADR-069: "business-hours arithmetic is the one place in this ADR where DST
 * bugs live, so it is a library with exhaustive tests, not inline date math."
 * This file is that library. It is PURE: it reads no clock and no database, so
 * every SLA transition built on it is deterministic under an injected `now`.
 *
 * ── the model ──────────────────────────────────────────────────────────────
 *
 * A calendar is a time zone, a set of weekly WINDOWS ("09:00"-"17:00" on day
 * 1) and a list of HOLIDAYS (local dates). Business time is the union of the
 * windows' REAL extents on the instant line — elapsed milliseconds, not wall
 * clock minutes. That is what makes a DST night the length the night really
 * is: Saturday 22:00 -> Sunday 06:00 is 7 real hours on the night the clocks go
 * forward and 9 on the night they go back, and a 24/7 calendar is exactly
 * elapsed time through any transition.
 *
 * Wall clocks become instants through lib/zoned-time.ts — the repo's one RFC
 * 5545 converter, built on `Intl` (no tz library is a dependency, and none is
 * added). It is the only offset source here; nothing in this file does offset
 * arithmetic of its own, and nothing reads the PROCESS zone.
 *
 *   - `day` is 0 = Sunday ... 6 = Saturday (`Date#getDay`, and the repo's
 *     schedule-window convention).
 *   - `start` is inclusive, `end` exclusive, "HH:MM". `end` may be "24:00".
 *   - OVERNIGHT: an `end` earlier than the `start` runs into the next morning
 *     (22:00-06:00). A window BELONGS TO THE DAY IT STARTS ON, so a holiday on
 *     a date removes the windows that start on it — the tail of Friday night
 *     into a Saturday holiday still happens; Friday's own night does not if
 *     Friday is the holiday.
 *   - A window whose start equals its end is zero length: no business time,
 *     never read as "all day" (say 00:00-24:00 for that).
 *   - Overlapping, adjacent and duplicate windows merge: nothing counts twice.
 *   - A wall clock that does not exist (the spring-forward gap) is read at the
 *     pre-gap offset; one that happens twice (fall back) is its FIRST
 *     occurrence — RFC 5545 §3.3.5, and the converter's contract. A window
 *     whose end then precedes its start is dropped, never run backwards.
 *   - `null` as a calendar means 24/7: plain elapsed time.
 *
 * ── the two operations ─────────────────────────────────────────────────────
 *
 *   addBusinessMinutes(start, m)       min { t >= start : B(start, t) >= m }
 *   businessMinutesBetween(a, b)       B(a, b), signed (negative if b < a)
 *
 * where B is the measure of business time. They are exact inverses: `add` then
 * `between` returns what was asked for, adding in two steps is adding the sum,
 * and `add(start, 0)` is `start` itself even outside hours. A target that
 * exactly fills a window is due at its CLOSE, not the next opening. Both work in
 * milliseconds underneath (`addBusinessMs`, `businessMsBetween`), which the SLA
 * engine uses to carry a pause as business time.
 *
 * Scanning stops after {@link MAX_SCAN_DAYS} days: a calendar whose holidays
 * swallow a decade is a configuration error to be told about, not a loop.
 */
import {
  canonicalZone,
  isCalendarYmd,
  isValidIanaZone,
  localPartsOf,
  parseYmd,
  zonedDateMinuteToUtc,
} from "../../lib/zoned-time.js";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface BusinessWindow {
  /** 0 = Sunday ... 6 = Saturday: the day the window STARTS on. */
  day: number;
  /** "HH:MM", inclusive. */
  start: string;
  /** "HH:MM" (or "24:00"), exclusive. Earlier than `start` = runs into the next morning. */
  end: string;
}

export interface BusinessCalendar {
  /** An IANA zone name — never a raw UTC offset, which has no DST rules. */
  timezone: string;
  windows: readonly BusinessWindow[];
  /** Local dates, "YYYY-MM-DD", in `timezone`. */
  holidays: readonly string[];
}

/** Most calendar windows a calendar may carry (a day with a lunch break is two). */
export const MAX_WINDOWS = 100;
/** Most holidays a calendar may carry. */
export const MAX_HOLIDAYS = 2000;
/** How far from its start an operation scans before it gives up: ten years. */
export const MAX_SCAN_DAYS = 3660;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Memoised days per compiled calendar; cleared when full, so it never grows unbounded. */
const DAY_CACHE_LIMIT = 4096;

// ── Clock and calendar parsing ───────────────────────────────────────────────

const CLOCK = /^(\d{2}):(\d{2})$/;

/**
 * "HH:MM" -> minutes since midnight. `allow24` lets "24:00" through — the END of
 * a day, meaningful only as a window's `end`. Throws RangeError for anything else.
 */
export function parseClock(value: string, allow24 = false): number {
  const m = typeof value === "string" ? CLOCK.exec(value) : null;
  if (!m) throw new RangeError(`not an HH:MM time: ${JSON.stringify(value)}`);
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (minutes > 59) throw new RangeError(`not an HH:MM time: ${JSON.stringify(value)}`);
  if (hours === 24 && minutes === 0 && allow24) return 1440;
  if (hours > 23) throw new RangeError(`not an HH:MM time: ${JSON.stringify(value)}`);
  return hours * 60 + minutes;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The calendar's shape, checked field by field. Throws RangeError naming what is wrong. */
function checkShape(input: unknown): BusinessCalendar {
  if (!isRecord(input)) throw new RangeError("a calendar is an object");
  const { timezone, windows, holidays } = input;
  if (!isValidIanaZone(timezone)) throw new RangeError(`not an IANA time zone: ${JSON.stringify(timezone)}`);
  if (!Array.isArray(windows)) throw new RangeError("windows must be a list");
  if (windows.length > MAX_WINDOWS) throw new RangeError(`at most ${MAX_WINDOWS} windows`);
  if (!Array.isArray(holidays)) throw new RangeError("holidays must be a list");
  if (holidays.length > MAX_HOLIDAYS) throw new RangeError(`at most ${MAX_HOLIDAYS} holidays`);
  const checked: BusinessWindow[] = windows.map((w, i) => {
    if (!isRecord(w)) throw new RangeError(`window ${i + 1} is not an object`);
    if (!Number.isInteger(w.day) || (w.day as number) < 0 || (w.day as number) > 6) {
      throw new RangeError(`window ${i + 1}: day must be 0 (Sunday) to 6 (Saturday)`);
    }
    parseClock(w.start as string);
    parseClock(w.end as string, true);
    return { day: w.day as number, start: w.start as string, end: w.end as string };
  });
  for (const h of holidays) {
    if (typeof h !== "string" || !isCalendarYmd(h)) {
      throw new RangeError(`not a YYYY-MM-DD date: ${JSON.stringify(h)}`);
    }
  }
  return { timezone: timezone as string, windows: checked, holidays: holidays as string[] };
}

/**
 * Validate a calendar an admin is SAVING and return it normalised: the runtime's
 * canonical zone name, windows ordered by day then start, holidays sorted and
 * de-duplicated. Stricter than the arithmetic needs: a calendar that could never
 * run an SLA is refused — at least one window, and no window whose start equals
 * its end (the arithmetic reads that as no time; a person who typed it meant
 * something else). Throws RangeError with a message fit to show.
 */
export function validateCalendarForSave(input: unknown): BusinessCalendar {
  const cal = checkShape(input);
  if (cal.windows.length === 0) throw new RangeError("add at least one window of business hours");
  for (const w of cal.windows) {
    if (parseClock(w.start) === parseClock(w.end, true)) {
      throw new RangeError(`a window can't start and end at the same time (${w.start})`);
    }
  }
  const windows = [...cal.windows].sort(
    (a, b) => a.day - b.day || parseClock(a.start) - parseClock(b.start) || parseClock(a.end, true) - parseClock(b.end, true),
  );
  return {
    timezone: canonicalZone(cal.timezone),
    windows,
    holidays: [...new Set(cal.holidays)].sort(),
  };
}

// ── Compilation ──────────────────────────────────────────────────────────────

/** [start, end) in epoch milliseconds, `end > start`. */
interface Interval {
  s: number;
  e: number;
}

/** A segment of one weekday, in minutes from THAT day's midnight; `e` may run past 1440. */
type Segment = readonly [s: number, e: number];

interface Compiled {
  tz: string;
  /** Index 0 = Sunday. Merged, sorted, non-overlapping. */
  byWeekday: Segment[][];
  holidays: ReadonlySet<string>;
  /** No window has any length: there is no business time to measure or add. */
  empty: boolean;
  dayCache: Map<number, Interval[]>;
}

const COMPILED = new WeakMap<object, Compiled>();

function compile(calendar: BusinessCalendar): Compiled {
  const hit = COMPILED.get(calendar);
  if (hit) return hit;
  const cal = checkShape(calendar);
  const perDay: Array<Array<[number, number]>> = [[], [], [], [], [], [], []];
  for (const w of cal.windows) {
    const s = parseClock(w.start);
    const e0 = parseClock(w.end, true);
    if (e0 === s) continue; // zero length: no time, never "all day"
    perDay[w.day]!.push([s, e0 < s ? e0 + 1440 : e0]);
  }
  const byWeekday: Segment[][] = perDay.map((segs) => {
    segs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: Array<[number, number]> = [];
    for (const [s, e] of segs) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    return merged;
  });
  const compiled: Compiled = {
    tz: cal.timezone,
    byWeekday,
    holidays: new Set(cal.holidays),
    empty: byWeekday.every((segs) => segs.length === 0),
    dayCache: new Map(),
  };
  COMPILED.set(calendar, compiled);
  return compiled;
}

// ── Calendar days ────────────────────────────────────────────────────────────
// A "day number" is whole days since 1970-01-01 of a LOCAL calendar date. Pure
// UTC arithmetic on the date's digits: it never touches the process zone.

const dayNumberOf = (ymd: string): number => {
  const { y, m, d } = parseYmd(ymd);
  const probe = new Date(Date.UTC(2000, 0, 1));
  probe.setUTCFullYear(y, m - 1, d);
  return Math.round(probe.getTime() / DAY_MS);
};

const ymdOfDay = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** 0 = Sunday. 1970-01-01 was a Thursday. */
const weekdayOfDay = (n: number): number => (((n + 4) % 7) + 7) % 7;

/** The instant `minute` minutes after local midnight of day `n` (minute may pass 1440). */
function instantAt(c: Compiled, n: number, minute: number): number {
  return minute >= 1440
    ? zonedDateMinuteToUtc(ymdOfDay(n + 1), minute - 1440, c.tz).getTime()
    : zonedDateMinuteToUtc(ymdOfDay(n), minute, c.tz).getTime();
}

/** The business intervals of the windows that START on day `n`, in order. */
function intervalsOf(c: Compiled, n: number): Interval[] {
  const cached = c.dayCache.get(n);
  if (cached) return cached;
  const out: Interval[] = [];
  if (!c.holidays.has(ymdOfDay(n))) {
    for (const [s, e] of c.byWeekday[weekdayOfDay(n)]!) {
      const from = instantAt(c, n, s);
      const to = instantAt(c, n, e);
      // The gap rule can put an end before its start: that window has no time.
      if (to > from) out.push({ s: from, e: to });
    }
    out.sort((x, y) => x.s - y.s);
  }
  if (c.dayCache.size >= DAY_CACHE_LIMIT) c.dayCache.clear();
  c.dayCache.set(n, out);
  return out;
}

/**
 * Business intervals in chronological order, from the local day BEFORE `fromMs`
 * (an overnight window that started yesterday may still be running) for at most
 * {@link MAX_SCAN_DAYS} days.
 */
function* intervalsFrom(c: Compiled, fromMs: number): Generator<Interval, void, void> {
  const first = dayNumberOf(localPartsOf(new Date(fromMs), c.tz).ymd) - 1;
  for (let i = 0; i <= MAX_SCAN_DAYS; i += 1) yield* intervalsOf(c, first + i);
}

// ── The operations ───────────────────────────────────────────────────────────

function assertInstant(value: Date, what: string): number {
  const ms = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isFinite(ms)) throw new RangeError(`${what}: not a valid instant`);
  return ms;
}

/**
 * The instant `ms` business milliseconds after `start`: the earliest instant at
 * which that much business time has elapsed. `ms = 0` is `start` itself.
 * `calendar = null` is 24/7. Throws RangeError for a negative or non-finite
 * length, an invalid start, or a calendar with no business time to spend.
 */
export function addBusinessMs(start: Date, ms: number, calendar: BusinessCalendar | null): Date {
  const from = assertInstant(start, "addBusinessMs start");
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`not a non-negative length: ${ms}`);
  const length = Math.round(ms);
  if (length === 0) return new Date(from);
  if (calendar === null) return new Date(from + length);
  const c = compile(calendar);
  if (c.empty) throw new RangeError("this calendar has no business hours");

  let remaining = length;
  let pos = from;
  for (const iv of intervalsFrom(c, from)) {
    const lo = Math.max(iv.s, pos);
    if (iv.e <= lo) continue;
    const available = iv.e - lo;
    if (remaining <= available) return new Date(lo + remaining);
    remaining -= available;
    pos = iv.e;
  }
  throw new RangeError(`no business time to spend within ${MAX_SCAN_DAYS} days of ${new Date(from).toISOString()}`);
}

/**
 * Business milliseconds in [a, b): signed — negative when `b` is before `a`.
 * `calendar = null` is 24/7. Throws RangeError for an invalid instant, or a span
 * longer than {@link MAX_SCAN_DAYS} on a calendar that still has hours to count.
 */
export function businessMsBetween(a: Date, b: Date, calendar: BusinessCalendar | null): number {
  const from = assertInstant(a, "businessMsBetween from");
  const to = assertInstant(b, "businessMsBetween to");
  if (from === to) return 0;
  if (to < from) return -businessMsBetween(b, a, calendar);
  if (calendar === null) return to - from;
  const c = compile(calendar);
  if (c.empty) return 0;

  let total = 0;
  let pos = from;
  for (const iv of intervalsFrom(c, from)) {
    if (iv.s >= to) return total;
    const lo = Math.max(iv.s, pos);
    const hi = Math.min(iv.e, to);
    if (hi > lo) total += hi - lo;
    if (iv.e > pos) pos = iv.e;
    if (pos >= to) return total;
  }
  throw new RangeError(`span is longer than ${MAX_SCAN_DAYS} days`);
}

/** {@link addBusinessMs} in minutes — the SLA vocabulary. */
export function addBusinessMinutes(start: Date, minutes: number, calendar: BusinessCalendar | null): Date {
  if (!Number.isFinite(minutes) || minutes < 0) throw new RangeError(`not a non-negative length: ${minutes}`);
  return addBusinessMs(start, minutes * MINUTE_MS, calendar);
}

/** {@link businessMsBetween} in (fractional) minutes: negative when `b` is before `a`. */
export function businessMinutesBetween(a: Date, b: Date, calendar: BusinessCalendar | null): number {
  return businessMsBetween(a, b, calendar) / MINUTE_MS;
}
