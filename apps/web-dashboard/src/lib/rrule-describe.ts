/**
 * feat/scene-schedules + KAN-6 — render a stored RRULE as a human summary.
 *
 * KAN-6: the rrule's BYHOUR/BYMINUTE are the WALL-CLOCK time in the row's
 * stored IANA timezone (`SceneSchedule.timezone`), and BYDAY is the LOCAL
 * weekday. So describing a rule is now a direct read — no UTC→local
 * conversion and no weekday shift (the pre-KAN-6 inverse of the build step).
 * A rule saved as "07:00 / MO" reads back as "Mon at 7:00 AM" for everyone,
 * matching what the owner typed, regardless of the viewer's own offset.
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

/**
 * Render the stored RRULE's wall-clock + weekday set as a local summary.
 *
 * The `timezone` parameter is accepted for call-site symmetry with the
 * stored row, but no conversion is applied: the rule's BYHOUR/BYMINUTE are
 * already the wall-clock time in that zone, so the summary reads them
 * directly. (Keeping the param means callers can pass `schedule.timezone`
 * without special-casing, and leaves room for a future "in <zone>" suffix.)
 */
export function describeRrule(rule: string, _timezone?: string): string {
  const p = parse(rule);
  const freq = (p.FREQ ?? "").toUpperCase();
  if (freq !== "DAILY" && freq !== "WEEKLY") {
    throw new Error(`unsupported FREQ: ${freq}`);
  }
  const hour = clampInt(p.BYHOUR, 0, 23);
  const minute = clampInt(p.BYMINUTE, 0, 59);
  const time = formatLocalTime(hour, minute);

  if (freq === "DAILY") return `Every day at ${time}`;

  const days = (p.BYDAY ?? "")
    .toUpperCase()
    .split(",")
    .filter((c): c is DayCode => DAY_CODES.includes(c as DayCode));
  if (days.length === 0) throw new Error("weekly rule with no BYDAY");

  const ordered = Array.from(new Set(days)).sort(
    (a, b) => DAY_CODES.indexOf(a) - DAY_CODES.indexOf(b),
  );

  const isWeekdays =
    ordered.length === 5 &&
    ["MO", "TU", "WE", "TH", "FR"].every((d) => ordered.includes(d as DayCode));
  if (isWeekdays) return `Weekdays at ${time}`;
  const isWeekend =
    ordered.length === 2 &&
    ordered.includes("SA") &&
    ordered.includes("SU");
  if (isWeekend) return `Weekends at ${time}`;

  return `${ordered.map(dayLabel).join(", ")} at ${time}`;
}

function clampInt(raw: string | undefined, lo: number, hi: number): number {
  const n = Number.parseInt(raw ?? "0", 10);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
