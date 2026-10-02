/**
 * WARP-2977 P2b (ADR-059 §3.6) — the opening-hours evaluator. PURE: no I/O,
 * no clock, no process timezone. Every wall clock goes through the one
 * RFC 5545 converter in lib/zoned-time.ts, in the SITE zone.
 *
 * The model (spec §3, §6.2):
 *   · one `DayHours` per ISO weekday, plus per-date exceptions that REPLACE
 *     that date's own window only;
 *   · a window belongs to the date it OPENS on: `hours` with closesMin <
 *     opensMin closes the next day (Fri 18:00–02:00), equal is refused
 *     (that is `open_all_day`);
 *   · windows are half-open [opens, closes), in absolute instants — so a
 *     close inside the repeated fall-back hour happens exactly once;
 *   · a window whose end is not after its start once DST is applied is
 *     dropped; adjacent or overlapping windows MERGE (Mon + Tue open all day
 *     has no midnight boundary; a Fri 18:00–02:00 tail runs straight into a
 *     Sat 01:00 opening).
 *
 * Windows for a local date D are generated lazily from D−1 forward (D−1's
 * past-midnight tail is the only earlier window that can still be open on
 * D). Closed days cost no Intl call, conversions are memoised per call, and
 * a forward scan stops at the first CONFIRMED boundary — a merged window's
 * end is only known once the next date has been looked at, and a window
 * still open at the edge of the horizon has no known end at all (24/7 ⇒ no
 * change ahead, never a fake one at day 370).
 *
 * Not-set hours mean the site counts as open all the time: `scheduledModeAt`
 * is 'open' and there is no boundary in either direction.
 */
import {
  isoWeekdayOf,
  localPartsOf,
  ymdAddDays,
  zonedDateMinuteToUtc,
  type IsoWeekday,
} from "./zoned-time.js";

/** How far ahead a forward scan looks. Covers every exception a person may set (today+366). */
export const HOURS_HORIZON_DAYS = 370;
/** How far back `lastChangeAtOrBefore` looks for the boundary that stamps a schedule flip. */
export const HOURS_LOOKBACK_DAYS = 8;
export const MINUTES_PER_DAY = 1440;

export type DayHours =
  | { kind: "closed" }
  | { kind: "open_all_day" }
  | { kind: "hours"; opensMin: number; closesMin: number };

export type WeekHours = Readonly<Record<IsoWeekday, DayHours>>;

export type SiteHours =
  | { state: "not_set" }
  | {
      state: "set";
      /** Canonical IANA zone. The ONLY zone the evaluator uses. */
      timezone: string;
      week: WeekHours;
      /** Site-local 'YYYY-MM-DD' → that date's own window. */
      exceptions: ReadonlyMap<string, DayHours>;
    };

export type SetSiteHours = Extract<SiteHours, { state: "set" }>;
export type ScheduledMode = "open" | "closed";

export interface ScheduleChange {
  at: Date;
  to: ScheduledMode;
}

export interface OpenWindow {
  start: Date;
  end: Date;
}

// ── the engine ────────────────────────────────────────────────────────────

interface RawWindow {
  start: number;
  end: number;
}

interface MergedWindow {
  start: number;
  end: number;
  /** False when the window may have begun before the scan's first date. */
  startKnown: boolean;
  /** False when the window is still open at the scan's last date (it may run on). */
  endKnown: boolean;
}

interface Evaluator {
  raw(ymd: string): RawWindow | null;
  wall(ymd: string, minute: number): number;
  localDate(t: Date): string;
}

function evaluator(h: SetSiteHours): Evaluator {
  const walls = new Map<string, number>();
  const wall = (ymd: string, minute: number): number => {
    const day = minute === MINUTES_PER_DAY ? ymdAddDays(ymd, 1) : ymd;
    const m = minute === MINUTES_PER_DAY ? 0 : minute;
    const key = `${day}@${m}`;
    const hit = walls.get(key);
    if (hit !== undefined) return hit;
    // Throws RangeError on a zone the runtime cannot resolve — never an
    // Invalid Date that every comparison below would silently read as false.
    const at = zonedDateMinuteToUtc(day, m, h.timezone).getTime();
    walls.set(key, at);
    return at;
  };
  const raw = (ymd: string): RawWindow | null => {
    const day = h.exceptions.get(ymd) ?? h.week[isoWeekdayOf(ymd)];
    let start: number;
    let end: number;
    switch (day.kind) {
      case "closed":
        return null;
      case "open_all_day":
        start = wall(ymd, 0);
        end = wall(ymd, MINUTES_PER_DAY);
        break;
      case "hours":
        start = wall(ymd, day.opensMin);
        end = day.closesMin > day.opensMin ? wall(ymd, day.closesMin) : wall(ymdAddDays(ymd, 1), day.closesMin);
        break;
    }
    // DST can collapse a short window to nothing (or invert it) — drop it.
    return end > start ? { start, end } : null;
  };
  return { raw, wall, localDate: (t) => localPartsOf(t, h.timezone).ymd };
}

/**
 * Merged open windows of the dates [fromYmd, fromYmd + days], in order. A
 * window is yielded only once the date after it has been looked at, so its
 * end is final (`endKnown`) — except the last one, which may continue past
 * the scan.
 */
function* mergedWindows(ev: Evaluator, fromYmd: string, days: number): Generator<MergedWindow> {
  let cur: MergedWindow | null = null;
  let ymd = fromYmd;
  for (let i = 0; i <= days; i++, ymd = ymdAddDays(ymd, 1)) {
    const w = ev.raw(ymd);
    if (!w) continue;
    if (cur && w.start <= cur.end) {
      if (w.end > cur.end) cur.end = w.end;
      continue;
    }
    if (cur) yield cur;
    let startKnown = true;
    if (i === 0) {
      // The date before the scan may still be open when this window opens.
      const before = ev.raw(ymdAddDays(fromYmd, -1));
      startKnown = !before || before.end < w.start;
    }
    cur = { start: w.start, end: w.end, startKnown, endKnown: true };
  }
  if (cur) {
    // `ymd` is now the first date past the scan: nothing of it opens before its midnight.
    cur.endKnown = cur.end < ev.wall(ymd, 0);
    yield cur;
  }
}

// ── the API ───────────────────────────────────────────────────────────────

/** 'open' or 'closed' by the opening hours alone at `t`. Not set ⇒ 'open'. */
export function scheduledModeAt(h: SiteHours, t: Date): ScheduledMode {
  if (h.state === "not_set") return "open";
  const ev = evaluator(h);
  const ms = t.getTime();
  const today = ev.localDate(t);
  // Only D−1 (its past-midnight tail) and D itself can contain an instant of D.
  for (const ymd of [ymdAddDays(today, -1), today]) {
    const w = ev.raw(ymd);
    if (w && w.start <= ms && ms < w.end) return "open";
  }
  return "closed";
}

/** The first merged boundary strictly after `t`, or null when none lies within the horizon. */
export function changeAfter(h: SiteHours, t: Date): ScheduleChange | null {
  if (h.state === "not_set") return null;
  const ev = evaluator(h);
  const ms = t.getTime();
  for (const w of mergedWindows(ev, ymdAddDays(ev.localDate(t), -1), HOURS_HORIZON_DAYS + 1)) {
    if (w.endKnown && w.end <= ms) continue;
    if (w.start > ms) return { at: new Date(w.start), to: "open" };
    // t is inside this window.
    return w.endKnown ? { at: new Date(w.end), to: "closed" } : null;
  }
  return null;
}

/** The first closed→open boundary strictly after `t`, or null (never open again within the horizon, or open throughout). */
export function openingAfter(h: SiteHours, t: Date): Date | null {
  if (h.state === "not_set") return null;
  const ev = evaluator(h);
  const ms = t.getTime();
  for (const w of mergedWindows(ev, ymdAddDays(ev.localDate(t), -1), HOURS_HORIZON_DAYS + 1)) {
    if (w.start > ms) return new Date(w.start);
  }
  return null;
}

/**
 * The latest merged boundary at or before `t`, within HOURS_LOOKBACK_DAYS —
 * what a schedule flip is stamped with when the ticker catches up. Null when
 * the hours are not set or no boundary lies in that range.
 */
export function lastChangeAtOrBefore(h: SiteHours, t: Date): Date | null {
  if (h.state === "not_set") return null;
  const ev = evaluator(h);
  const ms = t.getTime();
  let last: number | null = null;
  const note = (at: number): void => {
    if (at <= ms && (last === null || at > last)) last = at;
  };
  for (const w of mergedWindows(ev, ymdAddDays(ev.localDate(t), -HOURS_LOOKBACK_DAYS), HOURS_LOOKBACK_DAYS)) {
    if (w.start > ms) break;
    if (w.startKnown) note(w.start);
    // An end at or before t is final: nothing that opens after t can merge back into it.
    if (w.endKnown) note(w.end);
  }
  return last === null ? null : new Date(last);
}

/**
 * The open windows overlapping [from, to), clipped to it — the 7-day preview.
 * Not set ⇒ the whole range (the site counts as open all the time).
 */
export function openWindowsBetween(h: SiteHours, from: Date, to: Date): OpenWindow[] {
  const lo = from.getTime();
  const hi = to.getTime();
  if (!(hi > lo)) return [];
  if (h.state === "not_set") return [{ start: new Date(lo), end: new Date(hi) }];
  const ev = evaluator(h);
  const days = Math.min(HOURS_HORIZON_DAYS, Math.ceil((hi - lo) / 86_400_000) + 2);
  const out: OpenWindow[] = [];
  for (const w of mergedWindows(ev, ymdAddDays(ev.localDate(from), -1), days)) {
    if (w.start >= hi) break;
    const s = Math.max(w.start, lo);
    const e = Math.min(w.endKnown ? w.end : Number.POSITIVE_INFINITY, hi);
    if (e > s) out.push({ start: new Date(s), end: new Date(e) });
  }
  return out;
}

// ── validation and conversion ─────────────────────────────────────────────

export type DayHoursIssue = "MINUTE_RANGE" | "SAME_OPEN_CLOSE";

function isMinute(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n < MINUTES_PER_DAY;
}

/** One day's window: minutes in 0–1439, and open ≠ close (equal would be `open_all_day`). */
export function validateDay(d: DayHours): DayHoursIssue | null {
  if (d.kind !== "hours") return null;
  if (!isMinute(d.opensMin) || !isMinute(d.closesMin)) return "MINUTE_RANGE";
  if (d.opensMin === d.closesMin) return "SAME_OPEN_CLOSE";
  return null;
}

export type WeekIssue =
  | { code: "WEEKDAYS"; message: string }
  | { code: DayHoursIssue; weekday: number; message: string };

export type WeekdayHours = { weekday: number } & DayHours;

/** A full week: exactly 7 entries, one per ISO weekday 1..7, each a valid day. */
export function validateWeek(days: readonly WeekdayHours[]): WeekIssue | null {
  if (days.length !== 7) return { code: "WEEKDAYS", message: `expected 7 days, got ${days.length}` };
  const seen = new Set<number>();
  for (const d of days) {
    if (!Number.isInteger(d.weekday) || d.weekday < 1 || d.weekday > 7 || seen.has(d.weekday)) {
      return { code: "WEEKDAYS", message: "each weekday 1–7 must appear exactly once" };
    }
    seen.add(d.weekday);
  }
  for (const d of days) {
    const issue = validateDay(d);
    if (issue) {
      return {
        code: issue,
        weekday: d.weekday,
        message: issue === "SAME_OPEN_CLOSE" ? "opening and closing times are the same" : "time out of range",
      };
    }
  }
  return null;
}

/** A validated week as the evaluator's record. Throws on an invalid week. */
export function weekFrom(days: readonly WeekdayHours[]): WeekHours {
  const issue = validateWeek(days);
  if (issue) throw new RangeError(`invalid week: ${issue.message}`);
  const out: Partial<Record<IsoWeekday, DayHours>> = {};
  for (const d of days) out[d.weekday as IsoWeekday] = dayOnly(d);
  return out as WeekHours;
}

/** Strip a weekday (or any extra field) off a day, keeping exactly the DayHours shape. */
export function dayOnly(d: DayHours): DayHours {
  return d.kind === "hours" ? { kind: "hours", opensMin: d.opensMin, closesMin: d.closesMin } : { kind: d.kind };
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 'HH:MM' (00:00–23:59) → minutes since midnight, or null. */
export function hhmmToMinutes(s: string): number | null {
  const m = HHMM.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Minutes since midnight (0–1439) → 'HH:MM'. */
export function minutesToHhmm(min: number): string {
  if (!isMinute(min)) throw new RangeError(`minutesToHhmm: out of range: ${min}`);
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

const WEEKDAY_SHORT: Readonly<Record<IsoWeekday, string>> = {
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
  7: "Sun",
};

/** '21:00' — the site-local clock time of an instant, 24-hour. For audit rows only (/admin/audit keeps its own style). */
export function siteClock(instant: Date, tz: string): string {
  return minutesToHhmm(localPartsOf(instant, tz).minuteOfDay);
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Minutes since midnight → "9:10 PM": the dashboard's en-US clock (apps/web-dashboard/src/lib/security-time.ts). */
function clock12(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * "9:10 PM" — the site-local clock time of an instant, in the dashboard's
 * 12-hour style. For server copy the dashboard shows verbatim (feed row
 * summaries), so one screen never shows the same moment as '21:10' in one
 * line and '9:10 PM' in the next.
 */
export function siteClockCopy(instant: Date, tz: string): string {
  return clock12(localPartsOf(instant, tz).minuteOfDay);
}

/**
 * An instant relative to `now`, in the site zone, the way the dashboard's
 * mode card says it (`formatSiteWhen`): "5:02 PM" (same site day), "9:00 AM
 * tomorrow", "Tue 9:00 AM" (within 6 days either way), "Sep 30, 5:02 PM".
 * For the site_mode health row, which the Sources card shows verbatim.
 */
export function siteDayClockCopy(instant: Date, tz: string, now: Date): string {
  const at = localPartsOf(instant, tz);
  const today = localPartsOf(now, tz);
  const time = clock12(at.minuteOfDay);
  const utcDay = (ymd: string) => {
    const [y, m, d] = ymd.split("-").map(Number);
    return Date.UTC(y!, m! - 1, d!) / 86_400_000;
  };
  const diff = utcDay(at.ymd) - utcDay(today.ymd);
  if (diff === 0) return time;
  if (diff === 1) return `${time} tomorrow`;
  if (Math.abs(diff) <= 6) return `${WEEKDAY_SHORT[at.isoWeekday]} ${time}`;
  const [, month, day] = at.ymd.split("-").map(Number);
  return `${MONTH_SHORT[month! - 1]} ${day}, ${time}`;
}
