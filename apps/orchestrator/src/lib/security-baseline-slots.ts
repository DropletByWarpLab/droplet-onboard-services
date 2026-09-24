/**
 * WARP-2980 (ADR-059 P5, spec §6.2, D20) — site-local hour slots, cut in
 * TypeScript through the ONE converter (lib/zoned-time.ts). Pure.
 *
 * The zone is `resolveSecurityTimezone`'s (the site zone, else a valid
 * Workspace.tz, else nothing is built). The SQL build never converts time:
 * it receives the ≤ 28 × 24 slots' UTC bounds from here and only compares
 * instants. Postgres's tzdata and ICU's can differ, and that would be a third
 * converter (a grep test fails on `AT TIME ZONE` / `timezone(` in any
 * security-* file).
 *
 *   · A spring-forward gap hour has start = end and is dropped: that date is
 *     simply not observed at that hour.
 *   · A fall-back hour is ONE 120-minute slot. `localPartsOf` maps both of
 *     its halves to local hour 1, so the live side (`slotOf`) and the build
 *     agree.
 *   · Half-hour and 45-minute zones (Kolkata, Kathmandu) and 30-minute DST
 *     (Lord Howe) work unchanged: slots are wall-clock hours, their bounds
 *     come from the converter.
 */
import { isoWeekdayOf, localPartsOf, ymdAddDays, zonedDateMinuteToUtc } from "./zoned-time.js";
import { BASELINE } from "./security-baseline-math.js";

export type SecurityDayTypeValue = "weekday" | "weekend";

/** One site-local wall-clock hour of one date, with its UTC bounds. */
export interface BaselineSlot {
  /** Site-local date, 'YYYY-MM-DD'. */
  ymd: string;
  /** 0–23, the wall-clock hour. */
  hour: number;
  dayType: SecurityDayTypeValue;
  start: Date;
  /** Exclusive. */
  end: Date;
}

/** Site-local window, inclusive: 28 complete dates, the last being yesterday. */
export interface BaselineWindow {
  from: string;
  to: string;
}

/** ISO weekday 1–5 → weekday, 6–7 → weekend (brief §4.3; D27: the calendar's, not the site's). */
export function dayTypeOf(isoWeekday: number): SecurityDayTypeValue {
  return isoWeekday >= 6 ? "weekend" : "weekday";
}

/**
 * The slot an instant falls in, in `tz` — always one `windowSlots` cuts, so
 * the live side and the build can never disagree about where an event
 * belongs, and `start ≤ instant < end` always holds.
 *
 * That is the instant's wall-clock hour in every zone whose DST transitions
 * fall on the hour. A transition that does not (Pacific/Chatham, 02:45)
 * leaves a wall-clock hour in two pieces; the piece the converter cannot give
 * a slot of its own belongs to the neighbouring slot that contains it, so
 * Chatham's 15 minutes after its spring-forward jump count in hour 2.
 */
export function slotOf(instant: Date, tz: string): BaselineSlot {
  const { ymd, isoWeekday, minuteOfDay } = localPartsOf(instant, tz);
  const hour = Math.floor(minuteOfDay / 60);
  const start = zonedDateMinuteToUtc(ymd, hour * 60, tz);
  const end = zonedDateMinuteToUtc(ymd, (hour + 1) * 60, tz);
  const t = instant.getTime();
  if (start.getTime() <= t && t < end.getTime()) return { ymd, hour, dayType: dayTypeOf(isoWeekday), start, end };
  const around = windowSlots(ymdAddDays(ymd, -1), ymdAddDays(ymd, 1), tz);
  const hit = around.find((s) => s.start.getTime() <= t && t < s.end.getTime());
  if (!hit) throw new RangeError(`slotOf: no slot holds ${instant.toISOString()} in ${tz}`);
  return hit;
}

export function slotMinutes(slot: Pick<BaselineSlot, "start" | "end">): number {
  return (slot.end.getTime() - slot.start.getTime()) / 60_000;
}

/** The 28 complete site-local dates before today: today never scores itself (D4). */
export function windowFor(now: Date, tz: string): BaselineWindow {
  const today = localPartsOf(now, tz).ymd;
  return { from: ymdAddDays(today, -BASELINE.windowDays), to: ymdAddDays(today, -1) };
}

/** [local midnight of `ymd`, local midnight after it). A DST day is 23 or 25 hours. */
export function dayBounds(ymd: string, tz: string): { start: Date; end: Date } {
  return { start: zonedDateMinuteToUtc(ymd, 0, tz), end: zonedDateMinuteToUtc(ymd, 1440, tz) };
}

/** [the first date's local midnight, the local midnight after the last date). */
export function windowBounds(window: BaselineWindow, tz: string): { start: Date; end: Date } {
  return { start: zonedDateMinuteToUtc(window.from, 0, tz), end: zonedDateMinuteToUtc(window.to, 1440, tz) };
}

/** Every date from `from` to `to` inclusive. */
export function windowDates(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = ymdAddDays(d, 1)) out.push(d);
  return out;
}

/** Every (date, hour) slot of the window with start < end, in time order. */
export function windowSlots(from: string, to: string, tz: string): BaselineSlot[] {
  const out: BaselineSlot[] = [];
  for (const ymd of windowDates(from, to)) {
    const dayType = dayTypeOf(isoWeekdayOf(ymd));
    let start = zonedDateMinuteToUtc(ymd, 0, tz);
    for (let hour = 0; hour < 24; hour += 1) {
      const end = zonedDateMinuteToUtc(ymd, (hour + 1) * 60, tz);
      if (start.getTime() < end.getTime()) out.push({ ymd, hour, dayType, start, end });
      start = end;
    }
  }
  return out;
}
