// Pure calendar layout: which weeks a view shows, which items land where, and how
// multi-day items stack into lanes so a bar keeps ONE vertical position across
// the days it covers (WARP-3523). No React, no `Date`: every date is a
// `DateOnly`, so the layout is identical in every time zone and across DST.

import type { PmWorkItem } from "../types";
import { addDays, diffDays, eachDay, startOfMonth, startOfWeek, type DateOnly, type Weekday } from "./dateOnly";
import { isTerminal, scheduleOf, spanOf, type Span } from "./schedule";

/** The dashboard's existing Calendar surface starts its weeks on Sunday. */
export const WEEK_START: Weekday = 0;

/** A scheduled item and where it sits on the time axis. */
export interface CalendarEntry {
  item: PmWorkItem;
  span: Span;
}

/** Always six week rows, so the grid keeps one height as months change. */
export function monthWeeks(anchor: DateOnly, weekStart: Weekday = WEEK_START): DateOnly[][] {
  const first = startOfWeek(startOfMonth(anchor), weekStart);
  return Array.from({ length: 6 }, (_, w) => eachDay(addDays(first, w * 7), addDays(first, w * 7 + 6)));
}

export function weekOf(anchor: DateOnly, weekStart: Weekday = WEEK_START): DateOnly[] {
  const first = startOfWeek(anchor, weekStart);
  return eachDay(first, addDays(first, 6));
}

/** Items with at least one date, in a stable order. */
export function toEntries(items: PmWorkItem[]): CalendarEntry[] {
  const out: CalendarEntry[] = [];
  for (const item of items) {
    const span = spanOf(scheduleOf(item));
    if (span) out.push({ item, span });
  }
  return out.sort(compareEntries);
}

/** Open items with no dates at all — the "Unscheduled" panel. */
export function unscheduledItems(items: PmWorkItem[]): PmWorkItem[] {
  return items
    .filter((it) => !spanOf(scheduleOf(it)) && !isTerminal(it))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key, undefined, { numeric: true }));
}

function compareEntries(a: CalendarEntry, b: CalendarEntry): number {
  if (a.span.start !== b.span.start) return a.span.start < b.span.start ? -1 : 1;
  if (a.span.days !== b.span.days) return b.span.days - a.span.days;
  return a.item.sortOrder - b.item.sortOrder || a.item.key.localeCompare(b.item.key, undefined, { numeric: true });
}

export type Segment = "only" | "start" | "mid" | "end";

/** One day of one lane: a piece of an item's bar. */
export interface LaneCell {
  entry: CalendarEntry;
  segment: Segment;
  /** First cell of this item in THIS week — carries the label and the focus stop. */
  first: boolean;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface WeekLayout {
  /** `lanes[lane][dayIndex]` — null where the lane is free on that day. Visible lanes only. */
  lanes: Array<Array<LaneCell | null>>;
  /** Per day, the entries that did not fit in `maxLanes`. */
  hidden: CalendarEntry[][];
  /** Per day, how many entries are hidden. */
  overflow: number[];
}

/**
 * Pack `entries` into lanes for one 7-day row. Entries are placed longest-first
 * from their start, each in the first lane free across every column it covers
 * (greedy interval packing), so an item that spans Tue–Thu occupies the same
 * lane on all three days. Anything past `maxLanes` is reported per day instead
 * of drawn.
 */
export function layoutWeek(days: DateOnly[], entries: CalendarEntry[], maxLanes = Number.POSITIVE_INFINITY): WeekLayout {
  const first = days[0];
  const last = days[days.length - 1];
  const inWeek = entries
    .filter((e) => e.span.start <= last && e.span.end >= first)
    .sort(compareEntries);

  const laneCols: boolean[][] = []; // laneCols[lane][col] = occupied
  const placed: Array<{ entry: CalendarEntry; lane: number; c0: number; c1: number }> = [];
  const hidden: CalendarEntry[][] = days.map(() => []);

  for (const entry of inWeek) {
    const c0 = Math.max(0, diffDays(first, entry.span.start));
    const c1 = Math.min(days.length - 1, diffDays(first, entry.span.end));
    let lane = 0;
    for (; lane < laneCols.length; lane += 1) {
      let free = true;
      for (let c = c0; c <= c1; c += 1) if (laneCols[lane][c]) free = false;
      if (free) break;
    }
    if (lane >= maxLanes) {
      for (let c = c0; c <= c1; c += 1) hidden[c].push(entry);
      continue;
    }
    if (lane === laneCols.length) laneCols.push(days.map(() => false));
    for (let c = c0; c <= c1; c += 1) laneCols[lane][c] = true;
    placed.push({ entry, lane, c0, c1 });
  }

  const lanes: Array<Array<LaneCell | null>> = laneCols.map(() => days.map(() => null));
  for (const { entry, lane, c0, c1 } of placed) {
    const continuesBefore = entry.span.start < first;
    const continuesAfter = entry.span.end > last;
    for (let c = c0; c <= c1; c += 1) {
      let segment: Segment = "mid";
      if (c0 === c1 && !continuesBefore && !continuesAfter) segment = "only";
      else if (c === c0 && !continuesBefore) segment = "start";
      else if (c === c1 && !continuesAfter) segment = "end";
      lanes[lane][c] = { entry, segment, first: c === c0, continuesBefore, continuesAfter };
    }
  }

  return { lanes, hidden, overflow: hidden.map((h) => h.length) };
}

/** Entries grouped under the first visible day they appear on, for the narrow-screen agenda. */
export function agendaGroups(
  entries: CalendarEntry[],
  from: DateOnly,
  to: DateOnly,
): Array<{ day: DateOnly; entries: CalendarEntry[] }> {
  const byDay = new Map<DateOnly, CalendarEntry[]>();
  for (const e of entries) {
    if (e.span.end < from || e.span.start > to) continue;
    const day = e.span.start < from ? from : e.span.start;
    const bucket = byDay.get(day);
    if (bucket) bucket.push(e);
    else byDay.set(day, [e]);
  }
  return [...byDay.keys()].sort().map((day) => ({ day, entries: byDay.get(day) ?? [] }));
}
