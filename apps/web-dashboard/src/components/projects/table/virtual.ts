"use client";

// WARP-3537 — row windowing for the table ("the table renders 1,000 rows
// smoothly"). Only the rows near the viewport are in the DOM; the rest are one tall
// spacer. No library: the dashboard has none, and the table's rows are a fixed height
// per kind (a row, a group header), which is all the arithmetic needs.
//
// The arithmetic is pure (`layoutRows`, `visibleRange`, `scrollTopFor`) because it is
// the part worth testing and the one part jsdom — which has no layout — cannot run.

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject, type UIEvent } from "react";

export const ROW_HEIGHT = 44;
export const GROUP_HEIGHT = 36;
export const HEADER_HEIGHT = 36;
/** Rows drawn beyond each edge of the viewport, so a fast scroll never shows a gap. */
export const OVERSCAN = 8;
/** A scroller that has not been measured (first paint, jsdom) is treated as this tall. */
export const FALLBACK_VIEWPORT = 560;

/** Row tops: `offsets[i]` is where row i starts, `offsets[n]` is the total height. */
export function layoutRows(heights: readonly number[]): { offsets: number[]; total: number } {
  const offsets = new Array<number>(heights.length + 1);
  let y = 0;
  for (let i = 0; i < heights.length; i += 1) {
    offsets[i] = y;
    y += heights[i];
  }
  offsets[heights.length] = y;
  return { offsets, total: y };
}

/** The rows to draw — `[start, end)` — for a scroll position, with overscan. */
export function visibleRange(
  offsets: readonly number[],
  scrollTop: number,
  viewport: number,
  overscan: number,
): { start: number; end: number } {
  const n = offsets.length - 1;
  if (n <= 0) return { start: 0, end: 0 };
  // The last row whose top is at or above scrollTop.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= scrollTop) lo = mid;
    else hi = mid - 1;
  }
  const first = lo;
  // The first row whose top is at or below the viewport's bottom edge.
  const bottom = scrollTop + viewport;
  let end = first;
  while (end < n && offsets[end] < bottom) end += 1;
  return { start: Math.max(0, first - overscan), end: Math.min(n, end + overscan) };
}

/** The smallest scroll that puts row `index` fully in view (below a sticky header of `headerHeight`). */
export function scrollTopFor(
  offsets: readonly number[],
  index: number,
  scrollTop: number,
  viewport: number,
  headerHeight: number,
): number {
  const top = offsets[index];
  const bottom = offsets[index + 1];
  if (top - headerHeight < scrollTop) return Math.max(0, top - headerHeight);
  if (bottom > scrollTop + viewport) return bottom - viewport;
  return scrollTop;
}

export interface WindowedRows {
  ref: RefObject<HTMLDivElement | null>;
  onScroll: (e: UIEvent<HTMLDivElement>) => void;
  start: number;
  end: number;
  offsets: number[];
  total: number;
  /** Scroll just enough to show row `index`. */
  scrollToIndex: (index: number) => void;
}

export function useWindowedRows(heights: readonly number[], headerHeight: number = HEADER_HEIGHT): WindowedRows {
  const ref = useRef<HTMLDivElement | null>(null);
  const { offsets, total } = useMemo(() => layoutRows(heights), [heights]);
  const [viewport, setViewport] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback((e: UIEvent<HTMLDivElement>) => setScrollTop(e.currentTarget.scrollTop), []);

  const effectiveViewport = viewport > 0 ? viewport : FALLBACK_VIEWPORT;
  const { start, end } = visibleRange(offsets, scrollTop, effectiveViewport, OVERSCAN);

  const scrollToIndex = useCallback(
    (index: number) => {
      const el = ref.current;
      if (!el || index < 0 || index >= heights.length) return;
      const next = scrollTopFor(offsets, index, el.scrollTop, el.clientHeight > 0 ? el.clientHeight : FALLBACK_VIEWPORT, headerHeight);
      if (next !== el.scrollTop) {
        el.scrollTop = next;
        setScrollTop(next);
      }
    },
    [offsets, heights.length, headerHeight],
  );

  return { ref, onScroll, start, end, offsets, total, scrollToIndex };
}
