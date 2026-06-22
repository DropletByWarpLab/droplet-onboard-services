/**
 * feat/scene-schedules — render a stored UTC RRULE as a human summary.
 *
 * The stored rule is UTC (the orchestrator parser is UTC-only). To show the
 * owner when it ACTUALLY runs in their timezone, we resolve the rule's
 * BYHOUR/BYMINUTE (UTC) to local wall-clock and shift the weekday back across
 * the UTC→local midnight boundary — the inverse of scene-rrule.ts's build
 * step. This keeps the list honest: a rule saved as 14:00 UTC reads back as
 * "7:00 AM" for a UTC-7 owner, matching what they typed.
 *
 * Throws on a rule outside the supported FREQ=DAILY|WEEKLY subset so the
 * caller can fall back to a neutral label rather than print a wrong time.
 */
import { dayLabel, formatLocalTime, type DayCode } from "./scene-rrule";

const DAY_CODES: DayCode[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function parse(rule: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const seg of rule.replace(/^RRULE:/i, "").split(";")) {
    const eq = seg.indexOf("=");
    if (eq <= 0) throw new Error("malformed rrule segment");
    out[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1);
  }
  return out;
}

function shiftDay(day: DayCode, delta: number): DayCode {
  const idx = DAY_CODES.indexOf(day);
  return DAY_CODES[(idx + delta + 7) % 7];
}

/**
 * Convert a UTC (hour, minute) to local, returning the local time + the
 * day-delta the conversion crossed (so weekly weekdays can be shifted back).
 */
function utcTimeToLocal(
  utcHour: number,
  utcMinute: number,
  now: Date = new Date(),
): { localHour: number; localMinute: number; dayDelta: number } {
  const d = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      utcHour,
      utcMinute,
      0,
      0,
    ),
  );
  const localHour = d.getHours();
  const localMinute = d.getMinutes();
  let dayDelta = d.getDate() - d.getUTCDate();
  if (dayDelta > 1) dayDelta = -1;
  if (dayDelta < -1) dayDelta = 1;
  return { localHour, localMinute, dayDelta };
}

export function describeRrule(rule: string, now: Date = new Date()): string {
  const p = parse(rule);
  const freq = (p.FREQ ?? "").toUpperCase();
  if (freq !== "DAILY" && freq !== "WEEKLY") {
    throw new Error(`unsupported FREQ: ${freq}`);
  }
  const utcHour = clampInt(p.BYHOUR, 0, 23);
  const utcMinute = clampInt(p.BYMINUTE, 0, 59);
  const { localHour, localMinute, dayDelta } = utcTimeToLocal(
    utcHour,
    utcMinute,
    now,
  );
  const time = formatLocalTime(localHour, localMinute);

  if (freq === "DAILY") return `Every day at ${time}`;

  const byday = (p.BYDAY ?? "")
    .toUpperCase()
    .split(",")
    .filter((c): c is DayCode => DAY_CODES.includes(c as DayCode));
  if (byday.length === 0) throw new Error("weekly rule with no BYDAY");

  const localDays = Array.from(
    new Set(byday.map((d) => shiftDay(d, dayDelta))),
  ).sort((a, b) => DAY_CODES.indexOf(a) - DAY_CODES.indexOf(b));

  const isWeekdays =
    localDays.length === 5 &&
    ["MO", "TU", "WE", "TH", "FR"].every((d) => localDays.includes(d as DayCode));
  if (isWeekdays) return `Weekdays at ${time}`;
  const isWeekend =
    localDays.length === 2 &&
    localDays.includes("SA") &&
    localDays.includes("SU");
  if (isWeekend) return `Weekends at ${time}`;

  return `${localDays.map(dayLabel).join(", ")} at ${time}`;
}

function clampInt(raw: string | undefined, lo: number, hi: number): number {
  const n = Number.parseInt(raw ?? "0", 10);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
