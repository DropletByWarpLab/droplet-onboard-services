/**
 * WARP-463 (C2) — minimal RRULE parser.
 * KAN-6 — per-row IANA timezone (DST-correct recompute).
 *
 * The §7 carrier-delay example uses
 *     FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0
 * Daily / single-day weekly variants cover every spec we expect
 * operators to author from the dashboard. Anything beyond that
 * (RDATE, EXDATE, BYSETPOS, multi-frequency rules) returns null and
 * the scheduler logs + skips the schedule rather than fabricating a
 * fire time we can't justify.
 *
 * Format: an RRULE *content line* (no `RRULE:` prefix) — `FREQ=...;
 * BYDAY=...;...`. Case-insensitive on keys; case-sensitive on BYDAY
 * day codes (RFC 5545: `MO`, `TU`, `WE`, `TH`, `FR`, `SA`, `SU`).
 *
 * Times: BYHOUR / BYMINUTE / BYSECOND are interpreted as WALL-CLOCK in
 * the schedule's stored IANA timezone (`SceneSchedule.timezone`). When
 * the zone is "UTC" (the column default + the value every pre-KAN-6 row
 * is back-filled to) this collapses to the original UTC-only behaviour,
 * so existing schedules fire at exactly the same instant they did before.
 *
 * Why per-row tz: a routine authored as "07:00 local" must keep firing
 * at 07:00 LOCAL across a daylight-saving change. Freezing it to a single
 * UTC instant (the pre-KAN-6 behaviour) drifted it by an hour at every DST
 * boundary (07:00 PDT → 06:00 PST). Storing the zone + recomputing the
 * wall-clock against it each fire is the fix — the resolved UTC instant
 * shifts with the offset; the wall-clock the owner picked stays put.
 *
 * Zone math uses the built-in ECMA-402 `Intl.DateTimeFormat` (full IANA
 * tz database, same in Node and the browser) — no new dependency, matching
 * the AC constraint to reuse what the repo already ships.
 */

const DAY_CODES: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

interface ParsedRrule {
  freq: "DAILY" | "WEEKLY";
  byDay: number[] | null;
  byHour: number;
  byMinute: number;
  bySecond: number;
  interval: number;
}

function parseParams(rule: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const segment of rule.trim().split(";")) {
    const eq = segment.indexOf("=");
    if (eq <= 0) return null;
    const key = segment.slice(0, eq).toUpperCase();
    const value = segment.slice(eq + 1);
    if (key.length === 0 || value.length === 0) return null;
    out[key] = value;
  }
  return out;
}

function parseInt0(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function parseRrule(rule: string): ParsedRrule | null {
  // Strip optional leading "RRULE:" prefix so callers can pass either form.
  const body = rule.replace(/^RRULE:/i, "");
  const params = parseParams(body);
  if (!params) return null;
  const freqRaw = (params.FREQ ?? "").toUpperCase();
  if (freqRaw !== "DAILY" && freqRaw !== "WEEKLY") return null;
  const byDayRaw = params.BYDAY;
  let byDay: number[] | null = null;
  if (byDayRaw !== undefined) {
    const codes = byDayRaw.toUpperCase().split(",");
    const mapped: number[] = [];
    for (const c of codes) {
      const n = DAY_CODES[c];
      if (n === undefined) return null;
      mapped.push(n);
    }
    byDay = mapped;
  }
  if (freqRaw === "WEEKLY" && byDay === null) return null;
  const byHour = parseInt0(params.BYHOUR, 0);
  const byMinute = parseInt0(params.BYMINUTE, 0);
  const bySecond = parseInt0(params.BYSECOND, 0);
  if (byHour > 23 || byMinute > 59 || bySecond > 59) return null;
  const interval = Math.max(1, parseInt0(params.INTERVAL, 1));
  return {
    freq: freqRaw,
    byDay,
    byHour,
    byMinute,
    bySecond,
    interval,
  };
}

// --- timezone resolution (ECMA-402, no dependency) ---------------------

/**
 * Offset (ms) of the given UTC instant in `tz`: `localWallClock − utc`.
 * Throws RangeError for an unknown IANA zone (caller maps that to null).
 */
/**
 * Normalise an `hour == 24` midnight (some ICU builds report midnight as hour
 * 24 of the SAME day instead of hour 0 of the NEXT day) into hour 0 with the
 * day rolled forward. Resetting the hour WITHOUT advancing the day computes the
 * calendar a full day early — the bug this guards. The day-roll is applied as
 * `day + 1`; the caller's `Date.UTC` then normalises any out-of-range day into
 * the next month/year. Pure + exported for direct testing.
 */
function normalizeH24(parts: {
  year: number;
  month: number;
  day: number;
  hour: number;
}): { year: number; month: number; day: number; hour: number } {
  if (parts.hour !== 24) return parts;
  return { ...parts, day: parts.day + 1, hour: 0 };
}

function zoneOffsetMs(utc: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(utc);
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = Number.parseInt(p.value, 10);
  }
  // `hour` can come back as 24 for midnight under some ICU builds; h23 keeps
  // it 0-23, but normalise defensively so Date.UTC stays well-formed — and
  // roll the DAY forward, not just reset the hour (resetting alone would
  // compute the offset a full day early).
  const { year, month, day, hour } = normalizeH24({
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
  });
  const asUtcMs = Date.UTC(year, month - 1, day, hour, map.minute, map.second);
  return asUtcMs - utc.getTime();
}

/** True when `tz` is a zone Intl can resolve (validate once, up front). */
function isValidTimeZone(tz: string): boolean {
  try {
    // Throws RangeError on an unknown identifier.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * UTC instant whose wall-clock in `tz` is the given local Y/M/D h:m:s.
 *
 * The offset is itself a function of the instant, so we converge it: take the
 * offset at a first guess (local-as-if-UTC), apply it, then re-read the offset
 * at that corrected instant and re-apply. Two passes nail every real,
 * UNAMBIGUOUS wall-clock, including across a DST transition.
 *
 * Spring-forward gap (the requested wall-clock does NOT exist — e.g. 02:30 on a
 * "spring forward 02:00→03:00" day): the 2-pass converger lands on a UTC instant
 * whose wall-clock is on the PRE-transition side (it walks the offset backwards
 * into the gap), so a naive read returns 01:30 — an hour BEFORE the gap, which
 * also reads as "in the past" for a today-fire. We detect the gap by
 * round-tripping the candidate back to its actual wall-clock; if it doesn't
 * match the requested wall-clock, the time was skipped, so we snap to the
 * transition instant itself — the first valid local instant after the gap
 * (02:30 → 03:00 local), exactly as the contract claims. Daily/weekly cadences
 * then still fire on the gap day rather than vanishing or going backwards.
 */
function localWallClockToUtc(
  year: number,
  month: number, // 0-based
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): Date {
  const naiveMs = Date.UTC(year, month, day, hour, minute, second);
  // Pass 1: offset evaluated at the naive instant.
  const offset1 = zoneOffsetMs(new Date(naiveMs), tz);
  const utcMs1 = naiveMs - offset1;
  // Pass 2: re-evaluate the offset at the corrected instant (handles the hour
  // where the first guess landed on the wrong side of a transition).
  const offset2 = zoneOffsetMs(new Date(utcMs1), tz);
  const utcMs2 = naiveMs - offset2;
  // Reconcile the gap: if the candidate's actual wall-clock in `tz` doesn't
  // equal the requested wall-clock, the requested time falls in a
  // spring-forward gap. The two passes bracket the transition (utcMs1 on one
  // side, utcMs2 on the other); the gap end is the transition instant, which
  // we resolve exactly between them. Snapping there yields the first valid
  // local instant after the gap (e.g. 03:00 local), not the pre-gap
  // mis-resolution.
  if (!wallClockMatches(new Date(utcMs2), tz, year, month, day, hour, minute)) {
    return new Date(transitionInstant(utcMs1, utcMs2, tz));
  }
  return new Date(utcMs2);
}

/**
 * The exact UTC instant (minute-resolution — DST transitions land on a minute
 * boundary) at which the offset changes, given two instants `a`/`b` that
 * bracket a single transition. Bisects the [low, high] window: only reached on
 * the rare spring-forward-gap path, so the handful of extra `Intl` reads cost
 * nothing on the common path.
 */
function transitionInstant(a: number, b: number, tz: string): number {
  let lo = Math.min(a, b);
  let hi = Math.max(a, b);
  const offLo = zoneOffsetMs(new Date(lo), tz);
  while (hi - lo > 60_000) {
    // Snap the midpoint to a whole minute so we converge on the boundary.
    const mid = Math.floor((lo + hi) / 2 / 60_000) * 60_000;
    if (mid <= lo) break;
    if (zoneOffsetMs(new Date(mid), tz) === offLo) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * True when the wall-clock of `utc` in `tz` equals the requested local
 * Y/M/D h:m. Used to detect a spring-forward gap (no UTC instant maps to a
 * skipped wall-clock, so a candidate can never round-trip to it).
 */
function wallClockMatches(
  utc: Date,
  tz: string,
  year: number,
  month: number, // 0-based
  day: number,
  hour: number,
  minute: number,
): boolean {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(utc)) {
    if (p.type !== "literal") map[p.type] = Number.parseInt(p.value, 10);
  }
  const got = normalizeH24({
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
  });
  return (
    got.year === year &&
    got.month - 1 === month &&
    got.day === day &&
    got.hour === hour &&
    map.minute === minute
  );
}

/**
 * The local Y/M/D + weekday for a UTC instant in `tz`. Used to anchor BYDAY
 * to the LOCAL weekday (a "Monday" rule means Monday where the owner lives,
 * not Monday UTC).
 */
function localCalendarParts(
  utc: Date,
  tz: string,
): { year: number; month: number; day: number; weekday: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = dtf.formatToParts(utc);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const WEEKDAYS: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    year: Number.parseInt(map.year, 10),
    month: Number.parseInt(map.month, 10) - 1, // 0-based
    day: Number.parseInt(map.day, 10),
    weekday: WEEKDAYS[map.weekday] ?? 0,
  };
}

/**
 * Build the fire instant for `daysAhead` LOCAL days past `after`, at the
 * rule's wall-clock time, resolved in `tz`. The day arithmetic is done on
 * the LOCAL calendar so a +1-day step never lands on the wrong date when the
 * UTC and local calendars disagree (e.g. far-east / far-west zones).
 */
function buildAtZoned(
  after: Date,
  parsed: ParsedRrule,
  daysAhead: number,
  tz: string,
): Date {
  const base = localCalendarParts(after, tz);
  return localWallClockToUtc(
    base.year,
    base.month,
    base.day + daysAhead, // Date.UTC normalises month/year roll-over
    parsed.byHour,
    parsed.byMinute,
    parsed.bySecond,
    tz,
  );
}

// --- UTC-path helpers (the original, unchanged behaviour) --------------

function buildAt(after: Date, parsed: ParsedRrule, daysAhead: number): Date {
  const t = new Date(after.getTime());
  t.setUTCDate(t.getUTCDate() + daysAhead);
  t.setUTCHours(parsed.byHour, parsed.byMinute, parsed.bySecond, 0);
  return t;
}

/**
 * Compute the next fire time strictly after `after` for the given RRULE
 * body, interpreting BYHOUR/BYMINUTE/BYSECOND as wall-clock in `timezone`
 * (an IANA identifier; defaults to "UTC" for backward compatibility with
 * pre-KAN-6 rows). Returns null when the rule is malformed, uses an
 * unsupported FREQ, or `timezone` is not a resolvable IANA zone (the caller
 * logs + disables the schedule rather than fire at a wrong instant).
 */
export function nextFireFromRrule(
  rrule: string,
  after: Date,
  timezone = "UTC",
): Date | null {
  const parsed = parseRrule(rrule);
  if (!parsed) return null;
  if (!isValidTimeZone(timezone)) return null;

  // UTC fast-path: byte-for-byte the original behaviour so existing rows
  // (and the §7 tests) are unaffected. Skips all the Intl calendar math.
  if (timezone === "UTC") return nextFireUtc(parsed, after);

  return nextFireZoned(parsed, after, timezone);
}

/** Original UTC computation (BYHOUR/BYMINUTE interpreted in UTC). */
function nextFireUtc(parsed: ParsedRrule, after: Date): Date | null {
  if (parsed.freq === "DAILY") {
    const todayFire = buildAt(after, parsed, 0);
    if (todayFire.getTime() > after.getTime() && parsed.interval === 1) {
      return todayFire;
    }
    return buildAt(after, parsed, parsed.interval);
  }

  // FREQ=WEEKLY
  const byDay = parsed.byDay ?? [after.getUTCDay()];
  const baseWeekStart = startOfUtcWeek(after);
  for (let ahead = 0; ahead < 8 * parsed.interval; ahead += 1) {
    const candidate = buildAt(after, parsed, ahead);
    if (candidate.getTime() <= after.getTime()) continue;
    if (!byDay.includes(candidate.getUTCDay())) continue;
    if (parsed.interval > 1) {
      const candidateWeekStart = startOfUtcWeek(candidate);
      const weeksFromBase = Math.round(
        (candidateWeekStart.getTime() - baseWeekStart.getTime()) /
          (7 * 86_400_000),
      );
      if (weeksFromBase % parsed.interval !== 0) continue;
    }
    return candidate;
  }
  return null;
}

/**
 * Timezone-aware computation: BYHOUR/BYMINUTE are wall-clock in `tz`, and
 * BYDAY is matched against the LOCAL weekday. Candidate days are walked on
 * the local calendar so DST changes (and far-from-UTC zones) resolve to the
 * correct UTC instant for each day.
 */
function nextFireZoned(
  parsed: ParsedRrule,
  after: Date,
  tz: string,
): Date | null {
  if (parsed.freq === "DAILY") {
    const todayFire = buildAtZoned(after, parsed, 0, tz);
    if (todayFire.getTime() > after.getTime() && parsed.interval === 1) {
      return todayFire;
    }
    // Walk forward INTERVAL local days at a time until we clear `after`.
    for (let ahead = parsed.interval; ahead < 8 * parsed.interval + parsed.interval; ahead += parsed.interval) {
      const candidate = buildAtZoned(after, parsed, ahead, tz);
      if (candidate.getTime() > after.getTime()) return candidate;
    }
    return null;
  }

  // FREQ=WEEKLY — anchor BYDAY to the LOCAL weekday at the candidate day.
  const startLocal = localCalendarParts(after, tz);
  const byDay = parsed.byDay ?? [startLocal.weekday];
  // Local week-0 = the local Sunday on/before `after`'s local day, used for
  // the INTERVAL=N week gate so an N-weekly rule doesn't collapse to weekly.
  const baseWeekIndex = localWeekIndex(after, tz);
  for (let ahead = 0; ahead < 8 * parsed.interval; ahead += 1) {
    const candidate = buildAtZoned(after, parsed, ahead, tz);
    if (candidate.getTime() <= after.getTime()) continue;
    const candLocal = localCalendarParts(candidate, tz);
    if (!byDay.includes(candLocal.weekday)) continue;
    if (parsed.interval > 1) {
      const weeksFromBase = localWeekIndex(candidate, tz) - baseWeekIndex;
      if (weeksFromBase % parsed.interval !== 0) continue;
    }
    return candidate;
  }
  return null;
}

/**
 * A stable, monotonically-increasing week index for a UTC instant, measured
 * on the LOCAL (tz) Sunday-start calendar. Computed as the count of whole
 * days from a fixed UTC epoch to the local calendar date, divided into weeks
 * — DST-stable because it uses the local Y/M/D, not elapsed UTC ms.
 */
function localWeekIndex(utc: Date, tz: string): number {
  const { year, month, day, weekday } = localCalendarParts(utc, tz);
  // Days since the Unix epoch for this local calendar date (UTC midnight of
  // the same Y/M/D — a pure day count, offset-independent).
  const dayNumber = Math.floor(Date.UTC(year, month, day) / 86_400_000);
  // Shift back to the local week's Sunday, then bucket into 7-day weeks.
  return Math.floor((dayNumber - weekday) / 7);
}

function startOfUtcWeek(d: Date): Date {
  const w = new Date(d);
  w.setUTCDate(d.getUTCDate() - d.getUTCDay());
  w.setUTCHours(0, 0, 0, 0);
  return w;
}

/** Exported for direct testing of edge-case strings without a Date. */
export function _parseRruleForTests(rule: string): ParsedRrule | null {
  return parseRrule(rule);
}

/**
 * Exported for direct testing of the spring-forward-gap snap (KAN-6 finding 2)
 * without round-tripping through nextFireFromRrule's day-walk.
 */
export function _localWallClockToUtcForTests(
  year: number,
  month: number, // 0-based
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): Date {
  return localWallClockToUtc(year, month, day, hour, minute, second, tz);
}

/** Exported for direct testing of the hour==24 day-roll guard (KAN-6 finding 3). */
export function _normalizeH24ForTests(parts: {
  year: number;
  month: number;
  day: number;
  hour: number;
}): { year: number; month: number; day: number; hour: number } {
  return normalizeH24(parts);
}

/**
 * Validity check for the supported RRULE subset. Returns true when the
 * rule parses to a FREQ=DAILY|WEEKLY form the scheduler can advance.
 * Used by the scene-schedules route to 400 a bad RRULE at the boundary
 * rather than persist a row the ticker would immediately disable. The
 * timezone is validated separately at the route boundary.
 */
export function isSupportedRrule(rule: string): boolean {
  const parsed = parseRrule(rule);
  return parsed !== null && parsed.interval === 1;
}

/** True when `tz` is a resolvable IANA timezone identifier. */
export function isSupportedTimezone(tz: string): boolean {
  return isValidTimeZone(tz);
}

/**
 * The wall-clock hour + minute of a UTC instant in `tz`. Used by the KAN-6
 * legacy backfill to recover the LOCAL hour an existing UTC-encoded fire maps
 * to, so it can rewrite BYHOUR/BYMINUTE to the box-zone wall-clock while the
 * resolved firing instant stays put. Returns null for an unresolvable zone
 * (the caller leaves the row as UTC rather than crash).
 */
export function localWallClockOf(
  utc: Date,
  tz: string,
): { hour: number; minute: number } | null {
  if (!isValidTimeZone(tz)) return null;
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  });
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(utc)) {
    if (p.type !== "literal") map[p.type] = Number.parseInt(p.value, 10);
  }
  const hour = map.hour === 24 ? 0 : map.hour;
  return { hour, minute: map.minute };
}
