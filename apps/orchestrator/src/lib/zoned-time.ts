/**
 * Wall clocks in named IANA zones, without a tz-database dependency.
 *
 * WARP-2977 P2b: `zoneFormatter`, `timeZoneOffsetMs` and `zonedWallClockToUtc`
 * were MOVED here verbatim from services/ics.ts (WARP-2764), which imports
 * them back. There is ONE RFC 5545 converter on this box: the calendar feed
 * parser and the Security opening hours (lib/security-hours.ts) both resolve
 * wall clocks through it, so a DST fix lands in both at once. It stays pinned
 * by src/__tests__/ics.test.ts (Santiago, New York, the repeated hour) — do
 * not "simplify" it; read its own comment first.
 *
 * Added beside it for the opening hours: zone validation and
 * canonicalisation, the site-local parts of an instant, and calendar-date
 * arithmetic on 'YYYY-MM-DD' strings. Nothing here ever reads the PROCESS
 * zone (`getDay`, `getHours`, `new Date(y, m, d)`): the orchestrator
 * container sets no TZ, and a process-zone read is exactly the bug a
 * `TZ=Pacific/Kiritimati` test run exists to catch.
 */

/** The offset, in ms, that `tz` was running at the given instant —
 *  `utcInstant + offset === wall clock in tz`. Positive east of UTC.
 *
 *  Derived by formatting the instant *in* the zone and reading the wall-clock
 *  fields back, which is the only offset source available without a tz
 *  database dependency. Throws `RangeError` for a zone the runtime cannot
 *  resolve — callers must handle that rather than defaulting to UTC. */
/** One `Intl.DateTimeFormat` per zone, reused. Constructing a formatter is the
 *  expensive part, and resolving a feed costs several offset probes per event
 *  (two per DTSTART/DTEND, plus one per candidate) — a 500-event feed would
 *  otherwise build thousands of throwaway formatters on a box that is also
 *  running everything else. Keyed by zone; the set of zones a box ever sees is
 *  tiny and bounded by its subscriptions, so this never grows unboundedly. */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

export function zoneFormatter(tz: string): Intl.DateTimeFormat {
  const hit = zoneFormatters.get(tz);
  if (hit) return hit;
  // Throws RangeError for a zone the runtime cannot resolve — deliberately not
  // caught here, so callers keep the drop-rather-than-guess behaviour.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    // `hourCycle: h23` — `hour12: false` reports midnight as hour 24 on some
    // ICU builds, which would silently shift a midnight event by a day.
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  zoneFormatters.set(tz, fmt);
  return fmt;
}

export function timeZoneOffsetMs(utcInstantMs: number, tz: string): number {
  const parts = zoneFormatter(tz).formatToParts(new Date(utcInstantMs));
  const field = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : NaN;
  };
  const asIfUtc = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour"),
    field("minute"),
    field("second"),
  );
  return asIfUtc - utcInstantMs;
}

/** Resolve a wall clock in a named IANA zone to the UTC instant it denotes.
 *  Returns an Invalid Date if `tz` is not resolvable by the runtime — never a
 *  UTC guess, because a plausible wrong instant is worse than a dropped event
 *  (WARP-2764).
 *
 *  RFC 5545 §3.3.5 specifies both awkward cases, and they need opposite
 *  treatment, which is why this is not a single subtraction:
 *
 *   - **Repeated** local time (autumn fall-back — the hour occurs twice):
 *     *"the DATE-TIME value refers to the first occurrence"*. So: the EARLIER
 *     of the two valid instants.
 *   - **Nonexistent** local time (spring-forward gap — the hour never occurs):
 *     *"interpreted using the UTC offset before the gap in local times"*. That
 *     is the pre-gap offset, which shifts the event forward past the gap — the
 *     same answer Temporal's `compatible`, luxon and java.time give.
 *
 *  Method: an instant denotes wall clock `w` in `tz` iff `instant +
 *  offset(instant) === w`. Probe the offset a day either side (a single probe
 *  at the wall clock cannot see both sides of a transition — in the ambiguous
 *  hour the second reading always agrees with the first), build a candidate per
 *  distinct offset, and keep only those that actually round-trip. Zero
 *  survivors means the wall clock is in a gap, and the pre-gap offset is the
 *  spec's answer. Two survivors is the repeated hour, and `Math.min` is "first
 *  occurrence".
 *
 *  🔴 Do not "simplify" this back to correct-once-and-return. That version
 *  resolved the gap BACKWARD (a 02:30 New York start became 01:30 EST, two
 *  hours early) and, in the three zones whose transition is at midnight
 *  (America/Santiago, America/Havana, Atlantic/Azores), moved a 00:00 event to
 *  the PREVIOUS CALENDAR DAY. It also returned the LATER occurrence of the
 *  repeated hour in every zone east of UTC — 73 of 130 DST zones — which is a
 *  §3.3.5 violation, not a defensible policy choice. */
export function zonedWallClockToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  tz: string,
): Date {
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const DAY_MS = 86_400_000;
  let offsetBefore: number;
  let offsetAfter: number;
  try {
    offsetBefore = timeZoneOffsetMs(wallAsUtc - DAY_MS, tz);
    offsetAfter = timeZoneOffsetMs(wallAsUtc + DAY_MS, tz);
  } catch {
    return new Date(NaN);
  }
  const valid = [...new Set([offsetBefore, offsetAfter])]
    .map((off) => wallAsUtc - off)
    .filter((instant) => timeZoneOffsetMs(instant, tz) === wallAsUtc - instant);
  // No candidate round-trips ⇒ the local time does not exist ⇒ §3.3.5's
  // "UTC offset before the gap".
  return new Date(valid.length > 0 ? Math.min(...valid) : wallAsUtc - offsetBefore);
}


/**
 * A zone the runtime resolves AND that is an IANA name — not a raw UTC
 * offset. Modern ICU accepts `+05:00` as a `timeZone`, but an offset has no
 * DST rules: a site "on +01:00" would silently stop following its summer
 * time. Refused, like anything longer than the 64 characters
 * SecuritySiteHours.timezone stores.
 *
 * Builds a throwaway formatter rather than `zoneFormatter`'s cached one: the
 * input is user text, and caching every case spelling of every zone a client
 * sends would grow the cache without bound. Only canonical names reach it.
 */
export function isValidIanaZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return false;
  }
  return /^[A-Za-z]/.test(resolved) && /^[A-Za-z]/.test(tz);
}

/**
 * The runtime's canonical spelling of a valid zone (`us/eastern` →
 * `America/New_York`, `utc` → `UTC`). What SecuritySiteHours.timezone stores,
 * so one zone is always one string. Throws RangeError for an invalid zone —
 * check `isValidIanaZone` first.
 */
export function canonicalZone(tz: string): string {
  if (!isValidIanaZone(tz)) throw new RangeError(`not an IANA time zone: ${JSON.stringify(tz)}`);
  return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface LocalParts {
  /** The site-local calendar date, 'YYYY-MM-DD'. */
  ymd: string;
  isoWeekday: IsoWeekday;
  /** Minutes since site-local midnight, 0–1439. */
  minuteOfDay: number;
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function ymdOfUtcDate(d: Date): string {
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Split a 'YYYY-MM-DD' into numbers. Throws on a malformed or non-calendar date. */
export function parseYmd(ymd: string): { y: number; m: number; d: number } {
  const m = YMD.exec(ymd);
  if (!m) throw new RangeError(`not a YYYY-MM-DD date: ${JSON.stringify(ymd)}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!isCalendarYmd(ymd)) throw new RangeError(`not a calendar date: ${ymd}`);
  return { y, m: mo, d };
}

/** True for a real calendar date in 'YYYY-MM-DD' (no 2026-02-30, no 2026-13-01). */
export function isCalendarYmd(ymd: string): boolean {
  const m = YMD.exec(ymd);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  // Date.UTC maps years 0–99 onto 1900–1999; re-pin the year before comparing.
  probe.setUTCFullYear(y, mo - 1, d);
  return ymdOfUtcDate(probe) === ymd;
}

/** The ISO weekday of a calendar date — from `Date.UTC(...).getUTCDay()`, never the process zone. */
export function isoWeekdayOf(ymd: string): IsoWeekday {
  const { y, m, d } = parseYmd(ymd);
  const probe = new Date(Date.UTC(2000, 0, 1));
  probe.setUTCFullYear(y, m - 1, d);
  const js = probe.getUTCDay();
  return (js === 0 ? 7 : js) as IsoWeekday;
}

/** Calendar-date arithmetic: `ymdAddDays('2026-02-28', 1) === '2026-03-01'`. */
export function ymdAddDays(ymd: string, n: number): string {
  if (!Number.isInteger(n)) throw new RangeError(`ymdAddDays: not an integer day count: ${n}`);
  const { y, m, d } = parseYmd(ymd);
  const probe = new Date(Date.UTC(2000, 0, 1));
  probe.setUTCFullYear(y, m - 1, d + n);
  return ymdOfUtcDate(probe);
}

/**
 * Where an instant falls on the wall clock in `tz`: its local date, ISO
 * weekday and minute of the day. Throws RangeError for a zone the runtime
 * cannot resolve (never a UTC guess) and for an invalid instant.
 */
export function localPartsOf(instant: Date, tz: string): LocalParts {
  const ms = instant.getTime();
  if (!Number.isFinite(ms)) throw new RangeError("localPartsOf: invalid instant");
  const parts = zoneFormatter(tz).formatToParts(instant);
  const field = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : NaN;
  };
  const y = field("year");
  const mo = field("month");
  const d = field("day");
  const h = field("hour");
  const mi = field("minute");
  if (![y, mo, d, h, mi].every(Number.isFinite)) throw new RangeError(`localPartsOf: unreadable parts in ${tz}`);
  const ymd = `${String(y).padStart(4, "0")}-${pad2(mo)}-${pad2(d)}`;
  return { ymd, isoWeekday: isoWeekdayOf(ymd), minuteOfDay: h * 60 + mi };
}

/**
 * The instant a site-local date + minute-of-day denotes, through the one
 * RFC 5545 converter (a gap takes the pre-gap offset; a repeated time is its
 * first occurrence). `minute` may be 1440 — midnight at the END of `ymd`,
 * i.e. 00:00 of the next date. Throws RangeError for an invalid zone rather
 * than returning an Invalid Date a caller could compare against.
 */
export function zonedDateMinuteToUtc(ymd: string, minute: number, tz: string): Date {
  if (!Number.isInteger(minute) || minute < 0 || minute > 1440) {
    throw new RangeError(`zonedDateMinuteToUtc: minute out of range: ${minute}`);
  }
  const day = minute === 1440 ? ymdAddDays(ymd, 1) : ymd;
  const m = minute === 1440 ? 0 : minute;
  const { y, m: mo, d } = parseYmd(day);
  const at = zonedWallClockToUtc(y, mo, d, Math.floor(m / 60), m % 60, 0, tz);
  if (Number.isNaN(at.getTime())) throw new RangeError(`not a time zone the runtime resolves: ${JSON.stringify(tz)}`);
  return at;
}
