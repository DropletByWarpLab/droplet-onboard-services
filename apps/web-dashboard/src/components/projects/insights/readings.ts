// Plain-language readings for the Insights cards (brief §6: sentence case, no
// jargon, no exclamation marks, em-dashes for asides). Pure functions of the API
// response, so the wording is testable and the cards stay presentational.
//
// A reading says what the chart says, once, to someone who will not study the
// chart. It never judges ("worrying") and never promises ("on track"): it
// reports the number and what it is a number of.

import type { InsightsBand, InsightsCfdDay, InsightsDuration, InsightsGroupBy, PmInsights } from "./types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-09-07` → `Sep 7`. Built from the string: a date-only value never goes through `new Date` in local time. */
export function ymdLabel(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

/** The label under a bar: the first day of its week or day, or the month and year. */
export function bucketLabel(start: string, groupBy: InsightsGroupBy): string {
  if (groupBy === "month") {
    const [y, m] = start.split("-").map(Number);
    return `${MONTHS[m - 1]} ${y}`;
  }
  return ymdLabel(start);
}

/** The heading of a tooltip or table row for a bucket. */
export function bucketTitle(start: string, groupBy: InsightsGroupBy): string {
  return groupBy === "week" ? `Week of ${ymdLabel(start)}` : bucketLabel(start, groupBy);
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** 3 → "3", 2.5 → "2.5", 4.0 → "4". */
function trim1(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/**
 * "within ___": always rounded UP, because it is an upper bound. Days up to six
 * weeks, so that a reading ("within 15 days") and the figure beside it ("14.2
 * days") never disagree about the unit; weeks and months only where days stop
 * being the natural way to say it.
 */
export function withinPhrase(days: number): string {
  if (days <= 1) return "a day";
  if (days <= 42) return `${Math.ceil(days)} days`;
  if (days <= 120) return `${Math.ceil(days / 7)} weeks`;
  return `${Math.ceil(days / 30)} months`;
}

/** A duration as it reads on its own: "2.5 days", "9 weeks", "Under a day". */
export function formatDays(days: number): string {
  if (days < 1) return "Under a day";
  if (days < 42) return days < 1.05 ? "1 day" : `${trim1(days)} days`;
  if (days < 120) return `${Math.round(days / 7)} weeks`;
  return `${trim1(days / 30)} months`;
}

/** How long something has been going on, for the aging list: "4 days", "10 weeks". */
export function formatAge(days: number): string {
  if (days < 1) return "Under a day";
  if (days < 42) return plural(Math.floor(days), "day", "days");
  if (days < 120) return plural(Math.floor(days / 7), "week", "weeks");
  return plural(Math.floor(days / 30), "month", "months");
}

/** The labels for the duration histogram's buckets, from the edges the API reports. */
export function durationBucketLabels(edgesDays: number[]): string[] {
  const days = (d: number) => (d === 1 ? "1 day" : `${d} days`);
  const out: string[] = [`Under ${days(edgesDays[0])}`];
  for (let i = 0; i < edgesDays.length - 1; i++) {
    out.push(`${edgesDays[i]}–${days(edgesDays[i + 1])}`);
  }
  out.push(`${days(edgesDays[edgesDays.length - 1])} or more`);
  return out;
}

/** The same buckets as axis labels, in days: "<1", "1–2", … "30+". */
export function durationBucketShortLabels(edgesDays: number[]): string[] {
  const out: string[] = [`<${edgesDays[0]}`];
  for (let i = 0; i < edgesDays.length - 1; i++) out.push(`${edgesDays[i]}–${edgesDays[i + 1]}`);
  out.push(`${edgesDays[edgesDays.length - 1]}+`);
  return out;
}

function daysInclusive(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
}

export function throughputReading(t: PmInsights["throughput"], meta: PmInsights["meta"]): string {
  if (t.total === 0) return "Nothing was finished in this period.";
  const unit = meta.groupBy === "day" ? "day" : meta.groupBy === "week" ? "week" : "month";
  const unitDays = meta.groupBy === "day" ? 1 : meta.groupBy === "week" ? 7 : 30.4375;
  const perUnit = t.total / (daysInclusive(meta.from, meta.to) / unitDays);
  const what = plural(t.total, "item", "items");
  if (perUnit < 1) return `${what} finished — less than one a ${unit}.`;
  return `${what} finished — about ${perUnit >= 10 ? Math.round(perUnit) : trim1(perUnit)} a ${unit}.`;
}

export function flowReading(v: PmInsights["createdVsCompleted"]): string {
  if (v.created === 0 && v.completed === 0) return "No work was added or finished in this period.";
  if (v.completed > v.created) {
    return `More was finished than added — ${v.completed} finished, ${v.created} added.`;
  }
  if (v.created > v.completed) {
    return `More work was added than finished — ${v.created} added, ${v.completed} finished.`;
  }
  return `Added and finished are in step — ${v.created} each.`;
}

export function durationReading(kind: "cycle" | "lead", d: InsightsDuration): string {
  if (d.count === 0 || d.p85 === null || d.p50 === null) {
    return kind === "cycle"
      ? "Nothing to measure yet — no finished work was started in this period."
      : "Nothing to measure yet — no work was finished in this period.";
  }
  const from = kind === "cycle" ? "of starting" : "of being added";
  return `Most work finishes within ${withinPhrase(d.p85)} ${from} — half within ${withinPhrase(d.p50)}.`;
}

const WAITING: InsightsBand[] = ["backlog", "unstarted"];
const sum = (day: InsightsCfdDay, bands: InsightsBand[]): number => bands.reduce((n, b) => n + day[b], 0);

export function cumulativeFlowReading(days: InsightsCfdDay[]): string {
  if (days.length === 0) return "No history yet.";
  const first = days[0];
  const last = days[days.length - 1];
  const waiting = `${sum(first, WAITING)} to ${sum(last, WAITING)}`;
  const done = `${first.completed} to ${last.completed}`;
  return `Waiting work went from ${waiting}; finished work went from ${done}.`;
}

export function workloadReading(
  w: PmInsights["workload"],
  nameOf: (userId: string) => string,
): string {
  if (w.assignees.length === 0) return "Nothing is open right now.";
  const people = w.assignees.filter((a) => a.userId !== null);
  const unassigned = w.assignees.find((a) => a.userId === null);
  const top = people[0];
  if (!top || (unassigned && unassigned.openItems > top.openItems)) {
    return `Most open work has no owner yet — ${plural(unassigned?.openItems ?? 0, "item", "items")}.`;
  }
  const lead = `${nameOf(top.userId as string)} has the most open work — ${plural(top.openItems, "item", "items")}.`;
  return unassigned
    ? `${lead} ${plural(unassigned.openItems, "open item has", "open items have")} no owner.`
    : lead;
}

export function agingReading(a: PmInsights["agingWip"], cycleP85: number | null): string {
  if (a.total === 0) return "Nothing is in progress right now.";
  if (cycleP85 === null) {
    return `${plural(a.total, "item is", "items are")} in progress — the oldest for ${formatAge(a.items[0]?.ageDays ?? 0)}.`;
  }
  const older = a.items.filter((i) => i.ageDays > cycleP85).length;
  // The list holds only the oldest few, so when every one of them is over the
  // line the true count may be higher.
  const atLeast = older === a.items.length && a.total > a.items.length ? "At least " : "";
  if (older === 0) return "Nothing has been in progress longer than most finished work took.";
  return `${atLeast}${plural(older, "item has", "items have")} been in progress longer than most finished work took (${withinPhrase(cycleP85)}).`;
}
