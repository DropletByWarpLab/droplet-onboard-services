/**
 * WARP-2980 (ADR-059 P5 §8) — the words of /security/patterns, and the small
 * pure formatters behind them.
 *
 * "Patterns" and "what normal looks like" / "what's usual" are the UI's
 * words; "baseline" and "suppression" never appear. Like every Security
 * page, nothing here says monitor, armed, arm, alarm, secure, protected,
 * guard, space or zone (components/security/security-copy.test.ts scans
 * every export of this module).
 */

export const COPY = {
  title: "Patterns",
  sub: "What normal looks like for each area and camera, learned from the last 4 weeks. Droplet uses it to notice what isn't usual. It never changes because someone marks a flag as expected.",
  trial: "Trial: Droplet doesn't raise these flags yet.",

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
