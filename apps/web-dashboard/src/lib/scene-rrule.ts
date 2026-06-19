/**
 * feat/scene-schedules — build a UTC RRULE from the owner's local choices.
 *
 * The orchestrator's rrule.ts is UTC-only: BYHOUR/BYMINUTE/BYDAY are all
 * interpreted in UTC. The owner authors in their LOCAL wall-clock (a "7am"
 * routine must fire at 7am where they live), so this helper does the single
 * biggest correctness step: convert the chosen local time to UTC, AND shift
 * the chosen weekdays by the day-delta that conversion induces when it crosses
 * the UTC midnight boundary.
 *
 * Example: a user in UTC-7 (US Pacific) picking Monday 06:00 local. 06:00
 * PDT = 13:00 UTC same day → BYDAY=MO;BYHOUR=13. A user in UTC+9 picking
 * Monday 06:00 local = 21:00 UTC on the *previous* day (Sunday) → BYDAY=SU;
 * BYHOUR=21. Getting the weekday shift wrong fires "Monday 6am" on the wrong
 * day for anyone far enough from UTC.
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
  /** The UTC hour the rule resolves to — surfaced in the UI for honesty. */
  utcHour: number;
  utcMinute: number;
}

/**
 * Convert a local (hour, minute) on a reference date into UTC, returning the
 * UTC hour/minute and the day-delta (−1, 0, or +1) the conversion crossed.
 * Uses the supplied `now` only to anchor the timezone offset (DST-correct for
 * "today"); the cadence itself is recurring.
 */
function localTimeToUtc(
  hour: number,
  minute: number,
  now: Date = new Date(),
): { utcHour: number; utcMinute: number; dayDelta: number } {
  // Build a Date at the chosen LOCAL wall-clock time on `now`'s local day.
  const local = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hour,
    minute,
    0,
    0,
  );
  const utcHour = local.getUTCHours();
  const utcMinute = local.getUTCMinutes();
  // Day delta = UTC calendar day − local calendar day for the same instant.
  const localDay = local.getDate();
  const utcDay = local.getUTCDate();
  let dayDelta = utcDay - localDay;
  // Normalise month-boundary wrap (e.g. local 31st → UTC 1st = +1, not −30).
  if (dayDelta > 1) dayDelta = -1;
  if (dayDelta < -1) dayDelta = 1;
  return { utcHour, utcMinute, dayDelta };
}

function shiftDay(day: DayCode, delta: number): DayCode {
  const idx = DAY_CODES.indexOf(day);
  return DAY_CODES[(idx + delta + 7) % 7];
}

/** True when the selection means "every day" (none picked, or all 7). */
export function isDaily(days: DayCode[]): boolean {
  return days.length === 0 || days.length === 7;
}

/**
 * Build the UTC RRULE for the draft. Returns null if hour/minute are out of
 * range (defensive — the inputs are clamped, but never persist a bad rule).
 */
export function buildSceneRrule(
  draft: ScheduleDraft,
  now: Date = new Date(),
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

  const { utcHour, utcMinute, dayDelta } = localTimeToUtc(
    draft.hour,
    draft.minute,
    now,
  );

  const timePart = `BYHOUR=${utcHour};BYMINUTE=${utcMinute}`;

  if (isDaily(draft.days)) {
    return { rrule: `FREQ=DAILY;${timePart}`, utcHour, utcMinute };
  }

  // Weekly: shift each chosen weekday by the UTC day-delta, dedupe, and order
  // Sunday-first so the rule is stable regardless of chip click order.
  const shifted = Array.from(
    new Set(draft.days.map((d) => shiftDay(d, dayDelta))),
  ).sort((a, b) => DAY_CODES.indexOf(a) - DAY_CODES.indexOf(b));

  return {
    rrule: `FREQ=WEEKLY;BYDAY=${shifted.join(",")};${timePart}`,
    utcHour,
    utcMinute,
  };
}

/**
 * Human summary of a built rrule for the confirmation line, e.g.
 * "Every day at 7:00 AM" / "Weekdays at 6:00 PM". Local-time framing — the
 * caller passes the ORIGINAL local choices so the copy matches what the owner
 * typed, while the rrule it persists is UTC.
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
