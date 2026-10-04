"use client";

// Windowing for the Timeline's rows (WARP-3523). The dashboard has no
// virtualisation dependency, and fixed-height rows need very little: render only
// the rows near the scroll position and let the inner element's explicit height
// keep the scrollbar honest. The window state only changes when the scroll
// position crosses a row boundary, so scrolling does not re-render per tick.
// Adding a dependency for this would be heavier than the code it replaces.

import { useCallback, useLayoutEffect, useRef, useState, type RefObject, type UIEvent } from "react";
import { ROW_H, computeWindow, type RowWindow } from "./rows";

/** Used until the container has been measured (and in environments with no layout, e.g. jsdom). */
const FALLBACK_VIEWPORT = 600;

export function useWindowedRows(
  rowCount: number,
  opts: { rowHeight?: number; overscan?: number } = {},
): {
  ref: RefObject<HTMLDivElement | null>;
  win: RowWindow;
  onScroll: (e: UIEvent<HTMLDivElement>) => void;
} {
  const rowHeight = opts.rowHeight ?? ROW_H;
  const overscan = opts.overscan ?? 6;
  const ref = useRef<HTMLDivElement | null>(null);
  const scrollTop = useRef(0);
  const viewport = useRef(0);
  const [win, setWin] = useState<RowWindow>(() =>
    computeWindow({ scrollTop: 0, viewportHeight: FALLBACK_VIEWPORT, rowCount, rowHeight, overscan }),
  );

  const recompute = useCallback(() => {
    const next = computeWindow({
      scrollTop: scrollTop.current,
      viewportHeight: viewport.current || FALLBACK_VIEWPORT,
      rowCount,
      rowHeight,
      overscan,
    });
    setWin((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, [rowCount, rowHeight, overscan]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      recompute();
      return;
    }
    const measure = () => {
      viewport.current = el.clientHeight;
      scrollTop.current = el.scrollTop;
      recompute();
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [recompute]);

  const onScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      scrollTop.current = e.currentTarget.scrollTop;
      recompute();
    },
    [recompute],
  );

  return { ref, win, onScroll };
}
