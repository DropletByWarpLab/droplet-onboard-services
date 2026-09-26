/**
 * WARP-2980 (ADR-059 P5 §8) — the words of /security/patterns, and the small
 * pure formatters behind them.
 *
 * "Patterns" and "what normal looks like" / "what's usual" are the UI's
 * words; "baseline" and "suppression" never appear (the copy lint bans them).
 * PR-B adds "Expected activity" — what the routes and the code call a
 * suppression — and "How often Droplet was right". Like every Security page,
 * nothing here says monitor, armed, arm, alarm, secure, protected, guard,
 * space or zone (components/security/security-copy.test.ts scans every export
 * of this module).
 */
import type { SecurityPatternCode, SecuritySuppressionDays } from "@/lib/types";

export const COPY = {
  title: "Patterns",
  sub: "What normal looks like for each area and camera, learned from the last 4 weeks. Droplet uses it to notice what isn't usual. It never changes because someone marks a flag as expected.",
  trial: "Trial: Droplet notes what it would flag, but doesn't raise these flags yet.",

  learningTitle: "Learning",
  learningHint: "Droplet needs about two weeks of watching a camera before it knows what's usual there.",
  learning: "Learning what normal looks like — {days} of {needed} days",
  knows: "Knows what normal looks like",
  stale: "Hasn't been watching since {when}",
  notReporting: "Not reporting to Droplet yet",

  usualTitle: "What's usual",
  usualHint: "How often something was seen at each hour on the days Droplet was watching, over the last 4 weeks.",
  keyLabel: "Area or camera",
  areasGroup: "Areas",
  camerasGroup: "Cameras",
  labelGroup: "What was seen",
  weekdays: "Weekdays",
  weekends: "Weekends",
  cellSeen: "{days}, {range}: seen on {d} of {n} days",
  cellNotReady: "{days}, {range}: not enough yet",
  detail: "{days} {range} · seen on {d} of {n} days · usually {rate} an hour",
  detailVisit: " · longest usual visit: {visit}",
  detailNotReady: "{days} {range} · not enough yet — seen on {d} of {n} days so far",
  noVisits: "not enough visits yet",
  pick: "Choose an hour to see what's usual then.",
  legendNever: "Never",
  legendSome: "Some days",
  legendOften: "Often",
  legendMost: "Most days",
  legendNotReady: "Not enough yet",
  noKeys: "Nothing to show yet. Droplet needs a full day of watching before it can say what's usual.",

  noTimezone: "Droplet needs the site's timezone before it can learn what's usual.",
  setHours: "Set the opening hours",
  noCamerasTitle: "No cameras are reporting yet.",
  noCameras: "When a camera reports to Droplet, it starts learning what normal looks like there. That takes about two weeks.",
  notBuilt: "Droplet works out what's usual every night, from the days it has watched so far.",
  retry: "Retry",
} as const;

// ── WARP-2980 PR-B: expected activity and how often Droplet was right ──

/** The card on /security/patterns. It never promises an alert: after-hours alerts need hours, an inside area and a person to tell. */
export const EXPECTED_COPY = {
  title: "Expected activity",
  hint: "Activity that's normal for a place and time, as told to Droplet by someone who can change Security settings. Droplet won't flag it as unusual until it ends. It never hides someone inside after hours.",
  empty: "Nothing is marked as expected.",
  emptyManage: "Nothing is marked as expected. When something Droplet flags is normal for a place and time, add it here.",
  add: "Add expected activity",
  remove: "Remove",
  removeAria: "Remove expected activity: {what}, {when}",
  removed: "Removed. Droplet will flag this again when it isn't usual.",
  added: "Added. Droplet won't flag this as unusual until {date}.",
  inArea: "{label} in {place}",
  onCamera: "{label} on {place}",
  removedArea: "Removed area",
  until: "Until {date} · added by {name}",
  quietedOne: "Kept 1 flag quiet",
  quietedMany: "Kept {n} flags quiet",
  everyDay: "Every day",
  weekdays: "Weekdays",
  weekends: "Weekends",
  allDay: "All day",
  retry: "Retry",
} as const;

/** The add form. */
export const EXPECTED_DIALOG_COPY = {
  title: "Add expected activity",
  intro: "Droplet won't flag what you pick here as unusual at this place and time, for as long as you choose. It never hides someone inside after hours, and it keeps learning what's usual.",
  where: "Area or camera",
  what: "What was seen",
  days: "Days",
  from: "From",
  for: "For",
  flags: "Stop these flags",
  reason: "Why is this expected?",
  until: "For how long",
  /** Under "For how long": the site date it ends, before the person commits. */
  ends: "Ends {date}",
  hoursOne: "1 hour",
  hoursMany: "{n} hours",
  reasonPlaceholder: "The cleaner comes on weekday evenings",
  week: "A week",
  month: "A month",
  quarter: "3 months",
  year: "A year",
  save: "Add",
  cancel: "Cancel",
  saving: "Adding…",
  needFlag: "Choose at least one flag.",
  needReason: "Say why this is expected.",
  badReason: "The reason has characters Droplet can't store. Remove them and try again.",
  dwellPersonOnly: "Only people can stay longer than usual.",
  noKeys: "Droplet needs to learn what's usual somewhere first.",
} as const;

/** For how long, in days — what route 33 accepts (1–365), offered as four choices. */
export const EXPECTED_LENGTHS: ReadonlyArray<{ days: number; label: string }> = [
  { days: 7, label: EXPECTED_DIALOG_COPY.week },
  { days: 30, label: EXPECTED_DIALOG_COPY.month },
  { days: 90, label: EXPECTED_DIALOG_COPY.quarter },
  { days: 365, label: EXPECTED_DIALOG_COPY.year },
];

/** The card owner/admin see: counts from the first mark, a percentage from day 30. */
export const PRECISION_COPY = {
  title: "How often Droplet was right",
  // No verdict control ships yet (the incident page, F1): the hint never points at one. F1 restores the "marks … Not expected" wording.
  hint: "Once people can mark flagged incidents as expected or not, this shows how often each kind of flag was right, as a percentage after 30 days of marks.",
  none: "Nothing has been marked yet.",
  soFarOne: "1 mark so far",
  soFarMany: "{n} marks so far",
  right: "Right {right} of {n} times ({percent}%)",
  since: "since {date}",
} as const;

/** Each pattern flag's name, as the page and (later) the incident page say it. */
export const PATTERN_NAME: Readonly<Record<SecurityPatternCode, string>> = {
  out_of_place: "Not usual at this time",
  unusual_volume: "Busier than usual",
  long_dwell: "Stayed longer than usual",
};

/** The flags in the order the page lists them. */
export const PATTERN_ORDER: readonly SecurityPatternCode[] = ["out_of_place", "unusual_volume", "long_dwell"];

export const DAYS_NAME: Readonly<Record<SecuritySuppressionDays, string>> = {
  every_day: EXPECTED_COPY.everyDay,
  weekdays: EXPECTED_COPY.weekdays,
  weekends: EXPECTED_COPY.weekends,
};

/** The tracked labels' names; any other Frigate label is shown capitalised. */
export const LABEL_NAME: Readonly<Record<string, string>> = {
  person: "Person",
  car: "Car",
  dog: "Dog",
  cat: "Cat",
};

/** Tracked labels first, in this order; the rest alphabetically. */
export const TRACKED_LABELS = ["person", "car", "dog", "cat"] as const;

export function labelName(label: string): string {
  const known = LABEL_NAME[label];
  if (known) return known;
  const words = label.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function sortLabels(labels: readonly string[]): string[] {
  const rank = (l: string) => {
    const i = (TRACKED_LABELS as readonly string[]).indexOf(l);
    return i < 0 ? TRACKED_LABELS.length : i;
  };
  return [...labels].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** "{key}" placeholders → values. */
export function fillCopy(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}

const h12 = (hour: number) => (hour % 12 === 0 ? 12 : hour % 12);
const meridiem = (hour: number) => (hour < 12 ? "AM" : "PM");

/** One wall-clock hour, "2–3 AM", "11 AM–12 PM", "12–1 AM" (sep "–"), or "2 to 3 AM" (sep " to "). */
export function hourRange(hour: number, sep: string): string {
  const next = (hour + 1) % 24;
  if (meridiem(hour) === meridiem(next)) return `${h12(hour)}${sep}${h12(next)} ${meridiem(next)}`;
  return `${h12(hour)} ${meridiem(hour)}${sep}${h12(next)} ${meridiem(next)}`;
}

/** An hour's tick label, "12 AM", "6 PM". */
export function hourTick(hour: number): string {
  return `${h12(hour)} ${meridiem(hour)}`;
}

export type FillStep = "never" | "some" | "often" | "most";

/** The cell's shade, from the share of watched days something was seen: never, < 25 %, < 60 %, or most days. */
export function fillStep(daysWithEvent: number, daysObserved: number): FillStep {
  if (daysObserved <= 0 || daysWithEvent <= 0) return "never";
  const share = daysWithEvent / daysObserved;
  if (share < 0.25) return "some";
  if (share < 0.6) return "often";
  return "most";
}

/** A typical hourly count as people say it: "0", "0.4", "8", "15". */
export function formatRate(perHour: number): string {
  if (perHour < 0.05) return "0";
  if (perHour < 1) return perHour.toFixed(1);
  return String(Math.round(perHour));
}

/** A visit's length: "95 s" under two minutes, else "7 min". */
export function formatVisit(seconds: number): string {
  return seconds < 120 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`;
}

/** Detections a day: "fewer than one detection a day", "about 1 detection a day", "about 1,235 detections a day". */
export function formatPerDay(perDay: number): string {
  if (perDay < 1) return "fewer than one detection a day";
  const n = Math.round(perDay);
  return `about ${n.toLocaleString("en-US")} ${n === 1 ? "detection" : "detections"} a day`;
}

/**
 * A window of site hours: "10 PM–12 AM" (22, 2), "9 AM–5 PM" (9, 8); 24 hours
 * from midnight is "All day". Only from midnight: a window belongs to the day
 * it opens, so 24 hours from 3 PM is "3 PM–3 PM", never "All day" (route 33
 * and the table refuse that row; this never dresses it up).
 */
export function hoursSpan(hourFrom: number, hourCount: number): string {
  if (hourCount >= 24 && hourFrom === 0) return EXPECTED_COPY.allDay;
  return `${hourTick(hourFrom)}–${hourTick((hourFrom + hourCount) % 24)}`;
}

/**
 * An instant's date on the SITE's calendar (never the device's, never UTC):
 * "Oct 25", with the year when it is not the current site year ("Sep 25, 2027").
 */
export function siteDate(instant: string | Date, timeZone: string, now: Date): string {
  const at = instant instanceof Date ? instant : new Date(instant);
  const year = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(d);
  const sameYear = year(at) === year(now);
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(at);
}
