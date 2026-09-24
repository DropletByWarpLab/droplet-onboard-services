/**
 * WARP-2980 (ADR-059 P5, spec §6.2) — site-local hour slots, cut in
 * TypeScript through the one converter (lib/zoned-time.ts). Pure.
 *
 * S0 stub: the types and signatures. Slice A1 fills in the bodies.
 */

export type SecurityDayTypeValue = "weekday" | "weekend";

/** One site-local wall-clock hour of one date, with its UTC bounds. */
export interface BaselineSlot {
  /** Site-local date, 'YYYY-MM-DD'. */
  ymd: string;
  /** 0–23, the wall-clock hour. */
  hour: number;
  dayType: SecurityDayTypeValue;
  start: Date;
  /** Exclusive. A fall-back hour is 120 minutes; a spring-forward gap hour has no slot. */
  end: Date;
}

/** Site-local window, inclusive: 28 complete dates, the last being yesterday. */
export interface BaselineWindow {
  from: string;
  to: string;
}

export function dayTypeOf(isoWeekday: number): SecurityDayTypeValue {
  return isoWeekday >= 6 ? "weekend" : "weekday";
}

export function slotOf(instant: Date, tz: string): BaselineSlot {
  void instant;
  void tz;
  throw new Error("slotOf: not built yet (WARP-2980 A1)");
}

export function windowFor(now: Date, tz: string): BaselineWindow {
  void now;
  void tz;
  throw new Error("windowFor: not built yet (WARP-2980 A1)");
}

export function windowSlots(from: string, to: string, tz: string): BaselineSlot[] {
  void from;
  void to;
  void tz;
  return [];
}
