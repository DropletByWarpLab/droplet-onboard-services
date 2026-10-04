/**
 * WARP-3521 — "how far along is this cycle / module", one definition for both.
 *
 * `total` is every (non-archived) item attached. `completed` and `cancelled`
 * are split by the item's state GROUP — never by `isCompleted`, which is true
 * for both and would make a cancelled item read as work that got done. A
 * consumer that wants "closed" adds the two; one that wants "done of what was
 * actually planned" divides `completed` by `total - cancelled`. Everything
 * else (backlog / unstarted / started) is open.
 *
 * Each figure comes twice: as a count of items and as a sum of estimates
 * (`PmWorkItem.estimate`, points; an unset estimate weighs nothing).
 */

import type { PmStateGroup } from "@prisma/client";

export interface ApiPlanningProgress {
  total: number;
  completed: number;
  cancelled: number;
  totalEstimate: number;
  completedEstimate: number;
  cancelledEstimate: number;
}

/** The slice of a work item progress needs. `state` is null for an item with no state. */
export interface ProgressRow {
  estimate: number | null;
  state: { group: PmStateGroup } | null;
}

export function emptyProgress(): ApiPlanningProgress {
  return {
    total: 0,
    completed: 0,
    cancelled: 0,
    totalEstimate: 0,
    completedEstimate: 0,
    cancelledEstimate: 0,
  };
}

/** Two decimals — an estimate sum must not leak `0.30000000000000004` to the wire. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function summarizeProgress(rows: readonly ProgressRow[]): ApiPlanningProgress {
  const p = emptyProgress();
  for (const r of rows) {
    const weight = r.estimate ?? 0;
    p.total += 1;
    p.totalEstimate += weight;
    const group = r.state?.group;
    if (group === "completed") {
      p.completed += 1;
      p.completedEstimate += weight;
    } else if (group === "cancelled") {
      p.cancelled += 1;
      p.cancelledEstimate += weight;
    }
  }
  p.totalEstimate = round2(p.totalEstimate);
  p.completedEstimate = round2(p.completedEstimate);
  p.cancelledEstimate = round2(p.cancelledEstimate);
  return p;
}
