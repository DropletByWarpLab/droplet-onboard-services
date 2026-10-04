/**
 * WARP-3526 (ADR-069 WS-10) — the pure half of time tracking.
 *
 * Minute maths, week and range windows in a named IANA zone, and the day an
 * entry belongs to. Nothing here touches a database or reads a clock: every
 * function takes the instant it should reason about, so the tests can put
 * "now" anywhere — including a Monday that is still Sunday in UTC.
 *
 * Zone arithmetic goes through `lib/zoned-time.ts`, the one RFC 5545 converter
 * on this box, and never through the PROCESS zone (`getDay`,
 * `new Date(y, m, d)`): the orchestrator container sets no TZ, so a process-zone
 * read is correct on a developer laptop and wrong on the appliance.
 *
 * ── why a week is not `7 * 86_400_000` ─────────────────────────────────────
 *
 * A week is bounded at LOCAL midnight on both ends. In New York that makes it
 * 167 hours in the week the clocks spring forward and 169 in the week they fall
 * back. Adding seven days of milliseconds to the Monday instant lands an hour
 * off in both, and files the last hour of Sunday under the next Monday.
 *
 * ── why a day is the day an entry STARTED on ───────────────────────────────
 *
 * An entry is attributed whole to the local calendar day of its `startedAt`;
 * it is never split across midnight. A timesheet cell is therefore the sum of
 * the entries that began that day, which is also what a person means by
 * "Tuesday's hours".
 *
 * Errors are plain `Error(code)` with stable string codes, as pm.service.ts
 * does; routes/pm/time.ts maps them to HTTP.
 */

import {
  canonicalZone,
  isCalendarYmd,
  isValidIanaZone,
  isoWeekdayOf,
  localPartsOf,
  ymdAddDays,
  zonedDateMinuteToUtc,
} from "../../lib/zoned-time.js";

/** One entry is at least a minute… */
export const WORKLOG_MIN_MINUTES = 1;
/** …and at most a day. Longer work is several entries. Mirrors the
 *  `PmWorklog_minutes_range` CHECK in the WARP-3526 migration. */
export const WORKLOG_MAX_MINUTES = 24 * 60;
/** The longest report window, inclusive: a year and a day, which is one
 *  leap year. Bounds how many worklogs one request scans. */
export const MAX_REPORT_DAYS = 366;
/** How far past "now" a start time may be: clock skew between a browser and the
 *  box, not a licence to log tomorrow. */
export const FUTURE_START_SKEW_MS = 5 * 60_000;

export const PM_TIME_PARAM_ERRORS = {
  INVALID_TIMEZONE: "invalid_timezone",
  INVALID_WEEK_START: "invalid_week_start",
  INVALID_RANGE: "invalid_range",
} as const;

export type ReportGroupBy = "user" | "item" | "day";

const MINUTE_MS = 60_000;

/**
 * What stopping a timer writes: the elapsed time, rounded to the nearest minute
 * (half up), never less than one minute and never more than a day.
 *
 * A timer stopped after twenty seconds still leaves a one-minute entry. The
 * alternative — writing nothing — would make "stop" sometimes a delete, and the
 * entry is one click from being removed if it was a slip. A run longer than a
 * day is clamped to the per-entry maximum and `capped` says so, so the caller
 * can tell the person to correct it rather than quietly dropping the rest. A
 * `startedAt` after `now` (a clock that moved back) is the minimum, not a
 * negative.
 */
export function timerMinutes(startedAt: Date, now: Date): { minutes: number; capped: boolean } {
  const rounded = Math.round((now.getTime() - startedAt.getTime()) / MINUTE_MS);
  if (rounded > WORKLOG_MAX_MINUTES) return { minutes: WORKLOG_MAX_MINUTES, capped: true };
  return { minutes: Math.max(WORKLOG_MIN_MINUTES, rounded), capped: false };
}

/**
 * The zone a request reads in. Absent means UTC; present must be an IANA name
 * the runtime resolves (a raw offset is refused — it has no DST rules). The
 * return is the runtime's canonical spelling, so one zone is one string.
 */
export function resolveZone(tz: string | undefined): string {
  if (tz === undefined) return "UTC";
  if (!isValidIanaZone(tz)) throw new Error(PM_TIME_PARAM_ERRORS.INVALID_TIMEZONE);
  return canonicalZone(tz);
}

/** The local calendar date (`YYYY-MM-DD`) of an instant in `tz`. */
export function localDay(instant: Date, tz: string): string {
  return localPartsOf(instant, tz).ymd;
}

export interface TimeWeek {
  /** The Monday that opens the week, `YYYY-MM-DD` in `tz`. */
  weekStart: string;
  /** Seven local dates, Monday to Sunday. */
  days: string[];
  /** Local midnight at the start of Monday (inclusive). */
  from: Date;
  /** Local midnight at the start of the following Monday (exclusive). */
  to: Date;
}

/**
 * The Monday-to-Sunday week containing `weekStart` in `tz`, or the week
 * containing `now` when none is given. Any date inside a week names that week,
 * so a client may pass today without working out the Monday itself.
 */
export function resolveWeek(weekStart: string | undefined, tz: string, now: Date): TimeWeek {
  const anchor = weekStart ?? localDay(now, tz);
  if (!isCalendarYmd(anchor)) throw new Error(PM_TIME_PARAM_ERRORS.INVALID_WEEK_START);
  const monday = ymdAddDays(anchor, -(isoWeekdayOf(anchor) - 1));
  const days = Array.from({ length: 7 }, (_, i) => ymdAddDays(monday, i));
  return {
    weekStart: monday,
    days,
    from: zonedDateMinuteToUtc(monday, 0, tz),
    to: zonedDateMinuteToUtc(ymdAddDays(monday, 7), 0, tz),
  };
}

/** The position of the local day an instant falls on within `days`, or -1. */
export function dayIndex(days: readonly string[], instant: Date, tz: string): number {
  return days.indexOf(localDay(instant, tz));
}

export interface TimeRange {
  fromYmd: string;
  toYmd: string;
  /** Local midnight at the start of `fromYmd` (inclusive). */
  from: Date;
  /** Local midnight after `toYmd` (exclusive). */
  to: Date;
  /** Calendar days covered, inclusive. */
  days: number;
}

/** An inclusive calendar range in `tz`: whole local days, at most a year and a day. */
export function resolveRange(fromYmd: string, toYmd: string, tz: string): TimeRange {
  if (!isCalendarYmd(fromYmd) || !isCalendarYmd(toYmd) || toYmd < fromYmd) {
    throw new Error(PM_TIME_PARAM_ERRORS.INVALID_RANGE);
  }
  // `YYYY-MM-DD` sorts as dates do, so `toYmd < fromYmd` above is a date
  // comparison. The length is counted from the day AFTER the last one.
  const end = ymdAddDays(toYmd, 1);
  let days = 0;
  for (let d = fromYmd; d < end; d = ymdAddDays(d, 1)) {
    days += 1;
    if (days > MAX_REPORT_DAYS) throw new Error(PM_TIME_PARAM_ERRORS.INVALID_RANGE);
  }
  return {
    fromYmd,
    toYmd,
    from: zonedDateMinuteToUtc(fromYmd, 0, tz),
    to: zonedDateMinuteToUtc(end, 0, tz),
    days,
  };
}

/** What a report row is keyed by: a person, a work item, or a local day. */
export function groupKey(
  row: { workItemId: string; userId: string; startedAt: Date },
  groupBy: ReportGroupBy,
  tz: string,
): string {
  switch (groupBy) {
    case "user":
      return row.userId;
    case "item":
      return row.workItemId;
    case "day":
      return localDay(row.startedAt, tz);
  }
}
