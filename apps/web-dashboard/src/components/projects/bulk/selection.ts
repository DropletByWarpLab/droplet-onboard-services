"use client";

// WARP-3537 — the table's selection: a set of work-item ids, at most as many as one
// bulk request may carry (`PM_BULK_MAX_IDS`, 500). The bulk edit is ALL OR NOTHING,
// so a selection past the cap is not split into two requests (two decisions, no
// longer atomic) — it stops at the cap and says so.
//
// The rules are pure functions over sets; `useSelection` is a thin state holder.

import { useCallback, useMemo, useRef, useState } from "react";
import { PM_BULK_MAX_IDS } from "@droplet/shared-types";

export interface SelectionResult {
  next: ReadonlySet<string>;
  /** The cap stopped something being added. */
  capped: boolean;
}

export function toggle(sel: ReadonlySet<string>, id: string, max: number = PM_BULK_MAX_IDS): SelectionResult {
  const next = new Set(sel);
  if (next.delete(id)) return { next, capped: false };
  if (next.size >= max) return { next, capped: true };
  next.add(id);
  return { next, capped: false };
}

/** Add ids in the order given until the cap. `capped` is true only when something was LEFT OUT. */
export function addMany(sel: ReadonlySet<string>, ids: readonly string[], max: number = PM_BULK_MAX_IDS): SelectionResult {
  const next = new Set(sel);
  let capped = false;
  for (const id of ids) {
    if (next.has(id)) continue;
    if (next.size >= max) {
      capped = true;
      break;
    }
    next.add(id);
  }
  return { next, capped };
}

/** The ids from `from` to `to` inclusive, in on-screen order, whichever comes first. If the anchor
 *  is not on screen any more (filtered away, in a collapsed group) the range is just the clicked row. */
export function rangeBetween(order: readonly string[], from: string, to: string): string[] {
  const b = order.indexOf(to);
  if (b < 0) return [];
  const a = order.indexOf(from);
  if (a < 0) return [to];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** Drop ids that no longer exist in the list. The SAME set when nothing was dropped. */
export function prune(sel: ReadonlySet<string>, existing: ReadonlySet<string>): ReadonlySet<string> {
  let dropped = false;
  const next = new Set<string>();
  for (const id of sel) {
    if (existing.has(id)) next.add(id);
    else dropped = true;
  }
  return dropped ? next : sel;
}

export interface Selection {
  ids: ReadonlySet<string>;
  count: number;
  has: (id: string) => boolean;
  /** Toggle one row; with `shift` and an anchor, select the whole range in `order`. */
  select: (id: string, opts: { order: readonly string[]; shift?: boolean }) => void;
  /** Select every row in `order` (up to the cap). */
  selectAll: (order: readonly string[]) => void;
  clear: () => void;
  /** Drop selected ids that are not in `existing`. */
  prune: (existing: ReadonlySet<string>) => void;
  /** The last action hit the 500 cap. Cleared by the next action. */
  capped: boolean;
}

export function useSelection(): Selection {
  const [state, setState] = useState<{ ids: ReadonlySet<string>; capped: boolean }>({ ids: new Set(), capped: false });
  const anchor = useRef<string | null>(null);

  const select = useCallback((id: string, opts: { order: readonly string[]; shift?: boolean }) => {
    setState((s) => {
      if (opts.shift && anchor.current && anchor.current !== id) {
        const r = addMany(s.ids, rangeBetween(opts.order, anchor.current, id));
        return { ids: r.next, capped: r.capped };
      }
      anchor.current = id;
      const r = toggle(s.ids, id);
      return { ids: r.next, capped: r.capped };
    });
  }, []);

  const selectAll = useCallback((order: readonly string[]) => {
    anchor.current = null;
    setState(() => {
      const r = addMany(new Set(), order);
      return { ids: r.next, capped: r.capped };
    });
  }, []);

  const clear = useCallback(() => {
    anchor.current = null;
    setState((s) => (s.ids.size === 0 && !s.capped ? s : { ids: new Set(), capped: false }));
  }, []);

  const pruneTo = useCallback((existing: ReadonlySet<string>) => {
    setState((s) => {
      const next = prune(s.ids, existing);
      return next === s.ids ? s : { ids: next, capped: false };
    });
  }, []);

  return useMemo(
    () => ({
      ids: state.ids,
      count: state.ids.size,
      has: (id: string) => state.ids.has(id),
      select,
      selectAll,
      clear,
      prune: pruneTo,
      capped: state.capped,
    }),
    [state, select, selectAll, clear, pruneTo],
  );
}
