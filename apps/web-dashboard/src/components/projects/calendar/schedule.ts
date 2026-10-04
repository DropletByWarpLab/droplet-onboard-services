// The schedule of a work item — its start/due CALENDAR DATES — and the pure
// rules the calendar, timeline and My Work share (WARP-3523). Everything here
// works on `DateOnly`, never on `Date`, so a drag across a DST boundary keeps
// the calendar date (see dateOnly.ts).

import type { PmWorkItem, StateGroup } from "../types";
import {
  addDays,
  diffDays,
  formatDay,
  maxDate,
  minDate,
  parseDateOnly,
  toWireDate,
  type DateOnly,
} from "./dateOnly";

export interface Schedule {
  startDate: DateOnly | null;
  dueDate: DateOnly | null;
}

type ScheduleSource = Pick<PmWorkItem, "startDate" | "dueDate">;

/** The item's schedule as calendar dates, whichever wire form the API used. */
export function scheduleOf(item: ScheduleSource): Schedule {
  return { startDate: parseDateOnly(item.startDate), dueDate: parseDateOnly(item.dueDate) };
}

export function sameSchedule(a: Schedule, b: Schedule): boolean {
  return a.startDate === b.startDate && a.dueDate === b.dueDate;
}

/**
 * Where an item sits on a time axis. `point` = exactly ONE date is set (a
 * milestone-like diamond / a single chip); `span` = both are set (an inclusive
 * bar, even when they are the same day). `inverted` flags start > due data,
 * which the API does not forbid: it is drawn as the span between the two dates
 * rather than hidden.
 */
export interface Span {
  start: DateOnly;
  end: DateOnly;
  kind: "point" | "span";
  inverted: boolean;
  /** Inclusive number of days covered (>= 1). */
  days: number;
}

export function spanOf(s: Schedule): Span | null {
  const { startDate, dueDate } = s;
  if (startDate && dueDate) {
    const inverted = startDate > dueDate;
    const start = minDate(startDate, dueDate);
    const end = maxDate(startDate, dueDate);
    return { start, end, kind: "span", inverted, days: diffDays(start, end) + 1 };
  }
  const only = startDate ?? dueDate;
  if (!only) return null;
  return { start: only, end: only, kind: "point", inverted: false, days: 1 };
}

/** Move every date that is set by `days` (calendar days, DST-free). */
export function shiftSchedule(s: Schedule, days: number): Schedule {
  return {
    startDate: s.startDate ? addDays(s.startDate, days) : null,
    dueDate: s.dueDate ? addDays(s.dueDate, days) : null,
  };
}

/** Move the start edge of a span, never past its due date (a span is >= 1 day). */
export function withStart(s: Schedule, start: DateOnly): Schedule {
  if (!s.startDate || !s.dueDate) return s;
  return { startDate: minDate(start, s.dueDate), dueDate: s.dueDate };
}

/** Move the due edge of a span, never before its start date. */
export function withDue(s: Schedule, due: DateOnly): Schedule {
  if (!s.startDate || !s.dueDate) return s;
  return { startDate: s.startDate, dueDate: maxDate(due, s.startDate) };
}

/** Put an unscheduled item on a day: a single due date, the calendar's convention. */
export function dueOn(day: DateOnly): Schedule {
  return { startDate: null, dueDate: day };
}

/**
 * The PATCH body that turns `prev` into `next`: only the fields that changed,
 * `null` clearing one. `start_date` / `due_date` are the wire names native.ts's
 * `workItemPatchSchema` accepts.
 */
export function scheduleBody(prev: Schedule, next: Schedule): { start_date?: string | null; due_date?: string | null } {
  const body: { start_date?: string | null; due_date?: string | null } = {};
  if (prev.startDate !== next.startDate) body.start_date = next.startDate ? toWireDate(next.startDate) : null;
  if (prev.dueDate !== next.dueDate) body.due_date = next.dueDate ? toWireDate(next.dueDate) : null;
  return body;
}

const TERMINAL: ReadonlySet<StateGroup> = new Set<StateGroup>(["completed", "cancelled"]);

export function isTerminal(item: { state: { group: StateGroup } | null }): boolean {
  return item.state ? TERMINAL.has(item.state.group) : false;
}

/**
 * Overdue by CALENDAR DAY: open, with a due date strictly before the viewer's
 * `today`. An item due today is not overdue until tomorrow. (The older
 * `isOverdue` in config.ts compares an instant against `Date.now()`, which turns
 * a date-only value into "overdue since the evening before" west of UTC.)
 */
export function isOverdueOn(item: { dueDate: string | null; state: { group: StateGroup } | null }, today: DateOnly): boolean {
  const due = parseDateOnly(item.dueDate);
  if (!due || isTerminal(item)) return false;
  return due < today;
}

/** "Oct 3" · "Oct 3 – Oct 8" · "No dates" — for labels and announcements. */
export function describeSchedule(s: Schedule, locale?: string): string {
  const span = spanOf(s);
  if (!span) return "No dates";
  if (span.kind === "point" || span.start === span.end) return formatDay(span.start, "short", locale);
  return `${formatDay(span.start, "short", locale)} – ${formatDay(span.end, "short", locale)}`;
}
