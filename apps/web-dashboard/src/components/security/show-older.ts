"use client";

/**
 * WARP-3185 B — "Show older" on the Incidents list and the Everything feed.
 *
 * The button is aria-disabled while a page loads, never `disabled`: disabling
 * the focused button drops keyboard focus to <body> (the pattern HoursEditor's
 * Save and AreasPanel's Restore use). Because it stays pressable, a ref refuses
 * a second press between the click and the load starting — otherwise two
 * quick presses ask for two pages.
 *
 * When the last page lands the button goes away with it. If focus went with
 * it, it moves to the first row that page added — where the person was
 * heading — and never stays on <body>. A row with nothing focusable in it
 * takes focus itself (tabindex -1).
 */
import { useCallback, useEffect, useRef } from "react";

export interface ShowOlderOptions {
  /** Rows shown now. */
  count: number;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
}

/** Focus row `index` of `list` — only when focus has nowhere real to be (the button that had it is gone). */
function focusAddedRow(list: HTMLElement | null, index: number): void {
  const row = list?.children[index] as HTMLElement | undefined;
  if (!row) return;
  const active = document.activeElement;
  if (active && active !== document.body && document.contains(active)) return;
  const target = row.querySelector<HTMLElement>("a[href], button:not([disabled])");
  if (target) {
    target.focus();
    return;
  }
  row.tabIndex = -1;
  row.focus();
}

export function useShowOlder({ count, hasMore, isLoadingMore, onLoadMore }: ShowOlderOptions) {
  const listRef = useRef<HTMLUListElement | null>(null);
  // How many rows there were when Show older was pressed; null when no load is pending.
  const fromRef = useRef<number | null>(null);
  // The pending load was seen running (so one that brought nothing new still ends).
  const startedRef = useRef(false);

  const onClick = useCallback(() => {
    // The in-flight guard: the button stays pressable (aria-disabled).
    if (fromRef.current !== null || isLoadingMore) return;
    fromRef.current = count;
    startedRef.current = false;
    onLoadMore();
  }, [count, isLoadingMore, onLoadMore]);

  useEffect(() => {
    const from = fromRef.current;
    if (from === null) return;
    if (isLoadingMore) {
      startedRef.current = true;
      return;
    }
    const landed = count > from;
    if (!landed && !startedRef.current && hasMore) return;
    fromRef.current = null;
    startedRef.current = false;
    if (landed && !hasMore) focusAddedRow(listRef.current, from);
  }, [count, hasMore, isLoadingMore]);

  return { listRef, onClick };
}
