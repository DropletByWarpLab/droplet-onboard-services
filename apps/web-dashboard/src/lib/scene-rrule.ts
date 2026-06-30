/**
 * feat/scene-schedules + KAN-6 — build a wall-clock RRULE + IANA timezone
 * from the owner's local choices.
 *
 * KAN-6 added a per-row IANA timezone (`SceneSchedule.timezone`), and the
 * orchestrator now interprets BYHOUR/BYMINUTE as WALL-CLOCK in that zone.
 * So the editor no longer converts local→UTC (the pre-KAN-6 step that
 * drifted an hour at every daylight-saving change): it emits the chosen
 * local time VERBATIM and ships the browser's IANA zone alongside. The
 * ticker recomputes the next fire against that zone each time, so a "7am"
 * routine keeps firing at 7am local across a DST boundary.
 *
 * This is intentionally a small pure function so the component stays a thin
 * shell over tested logic.
 */

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
export type DayCode = (typeof DAY_CODES)[number];

/** All 7 day codes, Sunday-first, for the daily / "every day" case + the chip row. */
export const ALL_DAYS: DayCode[] = [...DAY_CODES];

export interface ScheduleDraft {
  /** Selected weekdays (local). Empty or all 7 → a daily cadence. */
  days: DayCode[];
  /** Local hour 0–23. */
  hour: number;
  /** Local minute 0–59. */
  minute: number;
}

export interface BuiltRrule {
  rrule: string;
  /** The IANA zone the rrule's wall-clock time is interpreted in. */
  timezone: string;
}

/** True when the selection means "every day" (none picked, or all 7). */
export function isDaily(days: DayCode[]): boolean {
  return days.length === 0 || days.length === 7;
}

/**
 * The browser's IANA timezone (e.g. "America/Los_Angeles"), falling back to
 * "UTC" if the runtime can't resolve one. Persisted with every schedule so
 * the orchestrator can recompute the next fire in the owner's zone.
 */
export function resolveTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Build the wall-clock RRULE for the draft + the timezone to store it under.
 * BYHOUR/BYMINUTE are the chosen LOCAL time, stored as-is (no UTC shift);
 * BYDAY is the chosen weekdays, ordered Sunday-first so the rule is stable
 * regardless of chip click order. Returns null if hour/minute are out of
 * range (defensive — the inputs are clamped, but never persist a bad rule).
 *
 * @param timezone optional override; defaults to the browser's IANA zone.
 */
export function buildSceneRrule(
  draft: ScheduleDraft,
  timezone: string = resolveTimezone(),
): BuiltRrule | null {
  if (
    !Number.isInteger(draft.hour) ||
    !Number.isInteger(draft.minute) ||
    draft.hour < 0 ||
    draft.hour > 23 ||
    draft.minute < 0 ||
    draft.minute > 59
  ) {
    return null;
  }

  const timePart = `BYHOUR=${draft.hour};BYMINUTE=${draft.minute}`;

  if (isDaily(draft.days)) {
    return { rrule: `FREQ=DAILY;${timePart}`, timezone };
  }

  // Weekly: dedupe + order Sunday-first so the rule is stable regardless of
  // chip click order. No day-shift — the wall-clock IS the local day.
  const ordered = Array.from(new Set(draft.days)).sort(
    (a, b) => DAY_CODES.indexOf(a) - DAY_CODES.indexOf(b),
  );

  return {
    rrule: `FREQ=WEEKLY;BYDAY=${ordered.join(",")};${timePart}`,
    timezone,
  };
}

/**
 * Human summary of a draft for the confirmation line, e.g.
 * "Every day at 7:00 AM" / "Weekdays at 6:00 PM". Local-time framing — the
 * draft already holds the owner's local choices.
 */
export function describeLocalSchedule(draft: ScheduleDraft): string {
  const time = formatLocalTime(draft.hour, draft.minute);
  if (isDaily(draft.days)) return `Every day at ${time}`;
  const ordered = [...draft.days].sort(
    (a, b) => DAY_CODES.indexOf(a) - DAY_CODES.indexOf(b),
  );
  const isWeekdays =
    ordered.length === 5 &&
    ["MO", "TU", "WE", "TH", "FR"].every((d) => ordered.includes(d as DayCode));
  if (isWeekdays) return `Weekdays at ${time}`;
  const isWeekend =
    ordered.length === 2 && ordered.includes("SA") && ordered.includes("SU");
  if (isWeekend) return `Weekends at ${time}`;
  return `${ordered.map(dayLabel).join(", ")} at ${time}`;
}

const DAY_LABELS: Record<DayCode, string> = {
  SU: "Sun",
  MO: "Mon",
  TU: "Tue",
  WE: "Wed",
  TH: "Thu",
  FR: "Fri",
  SA: "Sat",
};
export function dayLabel(d: DayCode): string {
  return DAY_LABELS[d];
}

/** 12-hour local time label, e.g. "7:00 AM", "6:30 PM". */
export function formatLocalTime(hour: number, minute: number): string {
  const ampm = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
}

/** The IANA-ish local timezone label to show the user (e.g. "America/Los_Angeles"). */
export function localTimezoneLabel(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "your local time";
  } catch {
    return "your local time";
  }
}
