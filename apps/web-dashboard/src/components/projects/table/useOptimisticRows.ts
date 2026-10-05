"use client";

// WARP-3537 — optimistic updates for the table (brief §4.4): "mutate the local view
// immediately, fire the write, then revalidate. On rejection, roll back to the prior
// snapshot and raise a toast."
//
// The query hook owns the server's rows (an SWR cache paged across several
// requests); this owns only what the person has asked for that the server has not yet
// confirmed: a small map of per-item overrides laid OVER those rows. Writing is
// "set the override, send, refresh, clear it"; a failure is "clear it" — the row is
// the server's again, so the roll-back is not a restore of a snapshot that could
// itself have gone stale. Nothing is mutated in the cache, so there is nothing to
// get out of step with it.

import { useCallback, useMemo, useState } from "react";
import type { ItemOverride } from "../bulk/plan";
import type { PmWorkItem } from "../types";

export interface OptimisticRows {
  /** Lay the overrides over `items`; an item marked `hidden` leaves the list. */
  apply: (items: PmWorkItem[]) => PmWorkItem[];
  /** Ids whose write is in flight — drawn as "saving". */
  pending: ReadonlySet<string>;
  set: (overrides: ReadonlyMap<string, ItemOverride>) => void;
  clear: (ids: Iterable<string>) => void;
}

export function useOptimisticRows(): OptimisticRows {
  const [map, setMap] = useState<ReadonlyMap<string, ItemOverride>>(() => new Map());

  const set = useCallback((overrides: ReadonlyMap<string, ItemOverride>) => {
    setMap((cur) => {
      const next = new Map(cur);
      for (const [id, o] of overrides) next.set(id, { ...next.get(id), ...o });
      return next;
    });
  }, []);

  const clear = useCallback((ids: Iterable<string>) => {
    setMap((cur) => {
      let next: Map<string, ItemOverride> | null = null;
      for (const id of ids) {
        if (!cur.has(id)) continue;
        next ??= new Map(cur);
        next.delete(id);
      }
      return next ?? cur;
    });
  }, []);

  const apply = useCallback(
    (items: PmWorkItem[]): PmWorkItem[] => {
      if (map.size === 0) return items;
      const out: PmWorkItem[] = [];
      for (const it of items) {
        const o = map.get(it.id);
        if (!o) out.push(it);
        else if (!o.hidden) out.push({ ...it, ...o });
      }
      return out;
    },
    [map],
  );

  const pending = useMemo(() => new Set(map.keys()), [map]);
  return useMemo(() => ({ apply, pending, set, clear }), [apply, pending, set, clear]);
}
