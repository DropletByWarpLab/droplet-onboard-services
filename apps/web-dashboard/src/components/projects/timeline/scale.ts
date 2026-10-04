// The Timeline's time axis: zoom levels, the fetched window, day <-> pixel, header
// ticks, bar and connector geometry (WARP-3523). Pure and `DateOnly`-only, so the
// chart is identical in every zone and across DST. No React, no `Date`.

import {
  addDays,
  addMonths,
  diffDays,
  formatDay,
  maxDate,
  minDate,
  monthNumberOf,
  startOfMonth,
  startOfWeek,
  weekdayOf,
  weekdayShort,
  yearOf,
  type DateOnly,
} from "../calendar/dateOnly";
import { WEEK_START } from "../calendar/layout";
import type { Span } from "../calendar/schedule";

export type Zoom = "day" | "week" | "month" | "quarter";
export const ZOOMS_IN_ORDER: readonly Zoom[] = ["day", "week", "month", "quarter"];
export const ZOOM_LABEL: Record<Zoom, string> = { day: "Day", week: "Week", month: "Month", quarter: "Quarter" };

interface ZoomSpec {
  pxPerDay: number;
  /** Days fetched/drawn before and after the anchor. before + after + 1 must stay <= 1100 (the API's cap). */
  before: number;
  after: number;
  /** How far "Earlier" / "Later" move the anchor. */
  step: number;
}

export const ZOOMS: Record<Zoom, ZoomSpec> = {
  day: { pxPerDay: 40, before: 30, after: 60, step: 30 },
  week: { pxPerDay: 14, before: 84, after: 182, step: 84 },
  month: { pxPerDay: 5, before: 180, after: 365, step: 180 },
  quarter: { pxPerDay: 1.6, before: 365, after: 730, step: 365 },
};

export interface Range {
  from: DateOnly;
  to: DateOnly;
}

export function rangeFor(anchor: DateOnly, zoom: Zoom): Range {
  const z = ZOOMS[zoom];
  return { from: addDays(anchor, -z.before), to: addDays(anchor, z.after) };
}

export interface Scale {
  range: Range;
  zoom: Zoom;
  pxPerDay: number;
  /** Drawn width of the whole window. */
  width: number;
  /** Left edge of a day, in px from the window's start (negative / past `width` when outside it). */
  x: (day: DateOnly) => number;
  /** The day under an x offset from the window's start. */
  dayAt: (x: number) => DateOnly;
}

export function makeScale(range: Range, zoom: Zoom): Scale {
  const pxPerDay = ZOOMS[zoom].pxPerDay;
  const days = diffDays(range.from, range.to) + 1;
  return {
    range,
    zoom,
    pxPerDay,
    width: days * pxPerDay,
    x: (day) => diffDays(range.from, day) * pxPerDay,
    dayAt: (x) => addDays(range.from, Math.floor(x / pxPerDay)),
  };
}

// ── header ticks ──────────────────────────────────────────────────────────────

export interface Tick {
  key: string;
  label: string;
  sub?: string;
  start: DateOnly;
  x: number;
  w: number;
  weekend?: boolean;
  today?: boolean;
}

type Unit = "day" | "week" | "month" | "quarter" | "year";

function firstOfNext(day: DateOnly, unit: Unit): DateOnly {
  switch (unit) {
    case "day":
      return addDays(day, 1);
    case "week":
      return addDays(startOfWeek(day, WEEK_START), 7);
    case "month":
      return addMonths(startOfMonth(day), 1);
    case "quarter": {
      const qStart = Math.floor((monthNumberOf(day) - 1) / 3) * 3 + 1;
      return addMonths(`${day.slice(0, 5)}${String(qStart).padStart(2, "0")}-01`, 3);
    }
    case "year":
      return `${String(yearOf(day) + 1).padStart(4, "0")}-01-01`;
  }
}

/** Consecutive `unit`-sized segments covering the window; the first and last may be partial. */
function segments(scale: Scale, unit: Unit): Array<{ start: DateOnly; days: number }> {
  const out: Array<{ start: DateOnly; days: number }> = [];
  let cursor = scale.range.from;
  while (cursor <= scale.range.to) {
    const next = firstOfNext(cursor, unit);
    const end = minDate(addDays(next, -1), scale.range.to);
    out.push({ start: cursor, days: diffDays(cursor, end) + 1 });
    cursor = next;
  }
  return out;
}

export function headerTicks(scale: Scale, today: DateOnly, locale?: string): { top: Tick[]; bottom: Tick[] } {
  const toTick = (seg: { start: DateOnly; days: number }, label: string, extra: Partial<Tick> = {}): Tick => ({
    key: `${seg.start}`,
    label,
    start: seg.start,
    x: scale.x(seg.start),
    w: seg.days * scale.pxPerDay,
    ...extra,
  });
  const containsToday = (seg: { start: DateOnly; days: number }) =>
    today >= seg.start && today <= addDays(seg.start, seg.days - 1);

  switch (scale.zoom) {
    case "day":
      return {
        top: segments(scale, "month").map((s) => toTick(s, formatDay(s.start, "monthYear", locale))),
        bottom: segments(scale, "day").map((s) => {
          const wd = weekdayOf(s.start);
          return toTick(s, String(Number(s.start.slice(8, 10))), {
            sub: weekdayShort(s.start, locale),
            weekend: wd === 0 || wd === 6,
            today: s.start === today,
          });
        }),
      };
    case "week":
      return {
        top: segments(scale, "month").map((s) => toTick(s, formatDay(s.start, "monthYear", locale))),
        bottom: segments(scale, "week").map((s) => toTick(s, formatDay(s.start, "short", locale), { today: containsToday(s) })),
      };
    case "month":
      return {
        top: segments(scale, "year").map((s) => toTick(s, String(yearOf(s.start)))),
        bottom: segments(scale, "month").map((s) => toTick(s, formatDay(s.start, "month", locale), { today: containsToday(s) })),
      };
    case "quarter":
      return {
        top: segments(scale, "year").map((s) => toTick(s, String(yearOf(s.start)))),
        bottom: segments(scale, "quarter").map((s) =>
          toTick(s, `Q${Math.floor((monthNumberOf(s.start) - 1) / 3) + 1}`, { today: containsToday(s) }),
        ),
      };
  }
}

/** Each Saturday–Sunday run inside the window as `{x, w}`, for the day and week zooms. */
export function weekendBands(scale: Scale): Array<{ key: string; x: number; w: number }> {
  if (scale.zoom !== "day" && scale.zoom !== "week") return [];
  const out: Array<{ key: string; x: number; w: number }> = [];
  let cursor = scale.range.from;
  while (cursor <= scale.range.to) {
    const wd = weekdayOf(cursor);
    if (wd === 6 || wd === 0) {
      const runEnd = wd === 6 ? addDays(cursor, 1) : cursor;
      const end = minDate(runEnd, scale.range.to);
      out.push({ key: cursor, x: scale.x(cursor), w: (diffDays(cursor, end) + 1) * scale.pxPerDay });
      cursor = addDays(end, 1);
    } else {
      cursor = addDays(cursor, 1);
    }
  }
  return out;
}

// ── bars ──────────────────────────────────────────────────────────────────────

/** Width of the diamond drawn for an item with exactly one date. */
export const DIAMOND = 14;

export interface BarGeom {
  left: number;
  width: number;
  clippedStart: boolean;
  clippedEnd: boolean;
}

/** A span clamped to the window; null when none of it is inside. */
export function barGeom(scale: Scale, span: Span): BarGeom | null {
  const { from, to } = scale.range;
  if (span.end < from || span.start > to) return null;
  const s = maxDate(span.start, from);
  const e = minDate(span.end, to);
  return {
    left: scale.x(s),
    width: (diffDays(s, e) + 1) * scale.pxPerDay,
    clippedStart: span.start < from,
    clippedEnd: span.end > to,
  };
}

/** Centre x of the day a single-date item sits on; null outside the window. */
export function pointCenter(scale: Scale, day: DateOnly): number | null {
  if (day < scale.range.from || day > scale.range.to) return null;
  return scale.x(day) + scale.pxPerDay / 2;
}

/** x where an item's bar ends / starts — where a dependency connector leaves / arrives. */
export function endX(scale: Scale, span: Span): number {
  return span.kind === "point" ? scale.x(span.end) + scale.pxPerDay / 2 + DIAMOND / 2 : scale.x(span.end) + scale.pxPerDay;
}
export function startX(scale: Scale, span: Span): number {
  return span.kind === "point" ? scale.x(span.start) + scale.pxPerDay / 2 - DIAMOND / 2 : scale.x(span.start);
}

// ── dependency connectors ─────────────────────────────────────────────────────

const ELBOW = 8;

export interface Connector {
  d: string;
  /** The blocked item starts before its blocker finishes: finish-to-start is violated. */
  conflict: boolean;
}

/**
 * An elbow from the blocker's end (x1, y1) to the blocked item's start (x2, y2),
 * both at row mid-height. When there is room it is the plain right-down-right
 * step; when the blocked item starts before the blocker ends it routes along the
 * row boundary instead, so the line never runs through the bars it joins.
 */
export function connector(x1: number, y1: number, x2: number, y2: number, rowHeight: number): Connector {
  if (x2 >= x1 + ELBOW * 2) {
    return { d: `M ${x1} ${y1} H ${x1 + ELBOW} V ${y2} H ${x2}`, conflict: false };
  }
  const detourY = y1 <= y2 ? y1 + rowHeight / 2 : y1 - rowHeight / 2;
  return {
    d: `M ${x1} ${y1} H ${x1 + ELBOW} V ${detourY} H ${x2 - ELBOW} V ${y2} H ${x2}`,
    conflict: x2 < x1,
  };
}
