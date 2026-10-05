/**
 * WARP-3522 — turning a filter's date tokens into instants.
 *
 * A date in the filter DSL is a CALENDAR date (`2026-10-03`) or a relative one
 * (`today`, `-7d`). A relative token needs a "today", and "today" is whatever
 * calendar day it is for THE PERSON ASKING — their zone, not the server's (the
 * orchestrator container sets no TZ) and not UTC's. Everything below goes
 * through `lib/zoned-time.ts`, the one RFC 5545 converter on the box, so a DST
 * fix lands here too; nothing in this file reads the process zone.
 *
 * Two storage kinds, because the two kinds of date column are different things:
 *
 *   `date`      — `dueDate` / `startDate`. A calendar date stored at 00:00:00Z
 *                 (the dashboard has always sent `new Date("YYYY-MM-DD")`, and
 *                 WS-1 makes that the contract). A day is [D 00:00Z, D+1 00:00Z)
 *                 whatever zone the viewer is in; the zone only decides which
 *                 date "today" is.
 *   `timestamp` — `createdAt` / `updatedAt`. A real instant, so a day is the
 *                 viewer's LOCAL day: 23, 24 or 25 hours long, and its start can
 *                 be a skipped midnight (zoned-time takes the first instant that
 *                 exists).
 *
 * Days are half-open and adjacent: `dayEnd(D)` IS `dayStart(D+1)`, so "before D"
 * and "after D-1" never leave a gap and never overlap, even across a DST step.
 */
import { relativeDateOffsetDays } from "@droplet/shared-types";
import {
  localPartsOf,
  parseYmd,
  ymdAddDays,
  zonedDateMinuteToUtc,
} from "../../../lib/zoned-time.js";

export type DateStorage = "date" | "timestamp";

/** The calendar date `now` falls on in `tz`. Throws RangeError for a zone the
 *  runtime cannot resolve — never a UTC guess. */
export function todayIn(now: Date, tz: string): string {
  return localPartsOf(now, tz).ymd;
}

/** An absolute date stays as it is; a relative token becomes `today` ± its offset. */
export function resolveDateToken(token: string, today: string): string {
  const offset = relativeDateOffsetDays(token);
  return offset === null ? token : ymdAddDays(today, offset);
}

function utcMidnight(ymd: string): Date {
  const { y, m, d } = parseYmd(ymd);
  // Date.UTC maps years 0–99 onto 1900–1999; set the year explicitly.
  const probe = new Date(Date.UTC(2000, 0, 1));
  probe.setUTCFullYear(y, m - 1, d);
  return probe;
}

/** The first instant of the calendar day `ymd`. */
export function dayStart(ymd: string, storage: DateStorage, tz: string): Date {
  return storage === "date" ? utcMidnight(ymd) : zonedDateMinuteToUtc(ymd, 0, tz);
}

/** The first instant AFTER the calendar day `ymd` — the exclusive upper bound. */
export function dayEnd(ymd: string, storage: DateStorage, tz: string): Date {
  return dayStart(ymdAddDays(ymd, 1), storage, tz);
}
