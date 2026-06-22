/**
 * WARP-463 (C2) — minimal RRULE parser.
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
 * Times: BYHOUR / BYMINUTE / BYSECOND are interpreted in **UTC**.
 * Operators authoring "9 AM weekdays" should encode it in UTC; the
 * dashboard's RRULE editor (out-of-scope for C2) will handle the TZ
 * conversion. Same posture as the existing cron-runtime.service.ts
 * patterns (no per-row timezone column).
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

function buildAt(after: Date, parsed: ParsedRrule, daysAhead: number): Date {
  const t = new Date(after.getTime());
  t.setUTCDate(t.getUTCDate() + daysAhead);
  t.setUTCHours(parsed.byHour, parsed.byMinute, parsed.bySecond, 0);
  return t;
}

/**
 * Compute the next fire time strictly after `after` for the given
 * RRULE body. Returns null when the rule is malformed or uses an
 * unsupported FREQ (caller logs + skips the schedule).
 */
export function nextFireFromRrule(
  rrule: string,
  after: Date,
): Date | null {
  const parsed = parseRrule(rrule);
  if (!parsed) return null;

  if (parsed.freq === "DAILY") {
    // Strict ">" semantics: if today's BYHOUR:BYMINUTE has already
    // passed, advance INTERVAL days. interval=1 daily fires every day.
    const todayFire = buildAt(after, parsed, 0);
    if (todayFire.getTime() > after.getTime() && parsed.interval === 1) return todayFire;
    return buildAt(after, parsed, parsed.interval);
  }

  // FREQ=WEEKLY
  const byDay = parsed.byDay ?? [after.getUTCDay()];
  // Anchor "week 0" at the UTC week (Sun-start) containing `after`. For
  // INTERVAL=N we only accept candidates that fall in week 0, N, 2N, ...
  // — without this gate the loop returns the first byDay match within
  // the search window, which collapses INTERVAL=N to INTERVAL=1 for any
  // matching weekday found before the next interval-aligned week.
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
 * Validity check for the supported RRULE subset. Returns true when the
 * rule parses to a FREQ=DAILY|WEEKLY form the scheduler can advance.
 * Used by the scene-schedules route to 400 a bad RRULE at the boundary
 * rather than persist a row the ticker would immediately disable. Same
 * UTC-only posture as `nextFireFromRrule`.
 */
export function isSupportedRrule(rule: string): boolean {
  return parseRrule(rule) !== null;
}
