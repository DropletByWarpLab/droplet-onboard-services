// Pure helpers for the time surface (WARP-3526): how a duration is read and
// shown, and calendar-date arithmetic on `YYYY-MM-DD` strings.
//
// Dates are strings on purpose. A "day" in a timesheet is a calendar date in a
// named zone, and the moment it becomes a `Date` the machine's own zone gets a
// vote — `new Date(2026, 9, 4)` is local midnight, `toISOString()` is UTC, and
// the two disagree about which day it is for half the planet. All date maths
// here goes through `Date.UTC` and reads the UTC fields; the only places a zone
// is consulted are `ymdInZone` (an `Intl` formatter with an explicit zone) and
// `startedAtForDay` (which means local time and says so).

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The per-entry limits — the same numbers the orchestrator enforces. */
export const MIN_ENTRY_MINUTES = 1;
export const MAX_ENTRY_MINUTES = 24 * 60;

// ── Durations ───────────────────────────────────────────────────────────────

/** 90 → "1h 30m", 45 → "45m", 120 → "2h", 0 → "0m". Whole minutes, never negative. */
export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** An elapsed time as a running clock: 00:12:34. Hours do not wrap at a day. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return [hh, mm, ss].map((n) => String(n).padStart(2, "0")).join(":");
}

// A unit is not followed by another letter. NOT `\b`: in `1h30m` the `h` and the
// `3` are both word characters, so there is no boundary there and the most
// natural way to type 90 minutes would be refused.
const UNIT_GROUP = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)(?![a-z])/g;

/**
 * Read what a person types into a duration box, as whole minutes, or null when
 * it is not a duration this surface accepts (1 minute to 24 hours).
 *
 * Accepted: a bare number is MINUTES (`90`); `45m`, `45 min`; `1h`, `2 hours`;
 * `1h 30m`, `1h30m`, `1 hour 30 minutes`, `1h and 30m`; decimal hours
 * (`1.5h`, `1,5h`); and `1:30`. A bare decimal (`1.5`) is refused — it could be
 * minutes or hours, and guessing in either direction logs the wrong amount.
 * Anything left over after the recognised parts (`1h30`, `1x`) refuses the whole
 * input rather than quietly using part of it.
 */
export function parseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/(\d),(\d)/g, "$1.$2");
  if (s === "") return null;

  let total: number | null = null;

  const clock = /^(\d{1,2}):([0-5]?\d)$/.exec(s);
  if (clock) {
    total = Number(clock[1]) * 60 + Number(clock[2]);
  } else if (/^\d+$/.test(s)) {
    total = Number(s);
  } else {
    let sum = 0;
    let found = false;
    const leftover = s
      .replace(UNIT_GROUP, (_, n: string, unit: string) => {
        found = true;
        sum += Number(n) * (unit.startsWith("h") ? 60 : 1);
        return " ";
      })
      .replace(/\band\b/g, "")
      .replace(/[\s,]+/g, "");
    if (found && leftover === "") total = sum;
  }

  if (total === null || !Number.isFinite(total)) return null;
  const minutes = Math.round(total);
  return minutes >= MIN_ENTRY_MINUTES && minutes <= MAX_ENTRY_MINUTES ? minutes : null;
}

// ── Calendar dates (YYYY-MM-DD) ─────────────────────────────────────────────

function parts(ymd: string): { y: number; m: number; d: number } {
  const [y, m, d] = ymd.split("-").map(Number);
  return { y, m, d };
}

function utcOf(ymd: string): Date {
  const { y, m, d } = parts(ymd);
  return new Date(Date.UTC(y, m - 1, d));
}

function ymdOfUtc(date: Date): string {
  const y = String(date.getUTCFullYear()).padStart(4, "0");
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(ymd: string, days: number): string {
  const date = utcOf(ymd);
  date.setUTCDate(date.getUTCDate() + days);
  return ymdOfUtc(date);
}

/** The Monday on or before a date — a week starts on Monday. */
export function mondayOf(ymd: string): string {
  const dow = utcOf(ymd).getUTCDay(); // 0 = Sunday
  return addDays(ymd, -((dow + 6) % 7));
}

export function weekdayShort(ymd: string): string {
  return WEEKDAYS[utcOf(ymd).getUTCDay()];
}

/** "Sep 28". */
export function fmtYmd(ymd: string): string {
  const { m, d } = parts(ymd);
  return `${MONTHS[m - 1]} ${d}`;
}

/** "Sep 28 – Oct 4, 2026", or with both years when the week spans New Year. */
export function formatWeekRange(weekStart: string): string {
  const end = addDays(weekStart, 6);
  const a = parts(weekStart);
  const b = parts(end);
  return a.y === b.y
    ? `${fmtYmd(weekStart)} – ${fmtYmd(end)}, ${b.y}`
    : `${fmtYmd(weekStart)}, ${a.y} – ${fmtYmd(end)}, ${b.y}`;
}

// ── Zones ───────────────────────────────────────────────────────────────────

/** The zone the browser reports, or UTC if it will not say. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The calendar date on the wall clock in `tz`. (`en-CA` formats as YYYY-MM-DD.) */
export function ymdInZone(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** The local day an entry started on. */
export function entryDay(iso: string, tz: string): string {
  return ymdInZone(new Date(iso), tz);
}

/**
 * When a hand-logged entry for `ymd` says the work began.
 *
 * ANY OTHER DAY than today is local MIDDAY: a wall-clock time that exists on
 * every day in every zone (midnight does not, in zones that change the clock at
 * midnight) and that is far enough from either edge that no zone arithmetic
 * moves it onto the neighbouring day. `new Date("…T12:00:00")` with no offset is
 * parsed as LOCAL time, which is the intent here — the browser's zone is the zone
 * the day was picked in.
 *
 * TODAY depends on who is asking. A CREATE passes no `now` and gets `undefined`:
 * the request carries no start time and the box stamps its own clock, so an
 * entry for today can never fail "Time can't start in the future" on a machine
 * whose clock runs a few minutes ahead of the box's. An EDIT that moves an entry
 * onto today must send something — omitting the field means "leave the start
 * alone" and the entry would silently stay on its old day — so it passes `now`
 * and gets the EARLIER of now and local midday: still today, and in the
 * afternoon safely behind any clock skew.
 */
export function startedAtForDay(ymd: string, todayYmd: string, now?: Date): string | undefined {
  const midday = new Date(`${ymd}T12:00:00`);
  if (ymd !== todayYmd) return midday.toISOString();
  if (now === undefined) return undefined;
  return new Date(Math.min(now.getTime(), midday.getTime())).toISOString();
}
