/**
 * WARP-3537 (WS-6b) — the bulk-edit contract: `POST /api/pm/work-items/bulk`
 * `{ ids, patch }`. One transaction, all or nothing; the orchestrator's
 * `services/pm/pm-bulk.service.ts` is what makes that true, this file is what both
 * sides agree on.
 *
 * The patch keys are the fields that EXIST on the branch this was built on:
 * state, priority, assignees, labels, the cycle and the work-item archive flag.
 * `type`, `estimate` and `moduleId` are NOT here — no column or write path exists
 * for them yet (WS-4 adds the first two, WS-5 the last) — and the route refuses an
 * unknown key rather than ignoring it, so a caller who sends one learns it today,
 * not when a later slice quietly starts honouring it.
 *
 * Semantics worth stating once:
 *   • `assigneeIds` REPLACES the assignee set (like `assignees` on the single-item
 *     PATCH); `[]` clears it. Labels are a delta: `addLabelIds` / `removeLabelIds`.
 *   • `cycleId: null` takes the item out of its cycle.
 *   • A field an item already holds is not a change: it writes no activity row.
 */

/** Items one request may change. A bigger selection is more than one decision. */
export const PM_BULK_MAX_IDS = 500;
/** Entries in one `assigneeIds` / `addLabelIds` / `removeLabelIds` list. */
export const PM_BULK_MAX_VALUES = 50;

export const PM_BULK_PATCH_KEYS = [
  "stateId",
  "priority",
  "assigneeIds",
  "addLabelIds",
  "removeLabelIds",
  "cycleId",
  "isArchived",
] as const;
export type PmBulkPatchKey = (typeof PM_BULK_PATCH_KEYS)[number];

export interface PmBulkPatch {
  stateId?: string;
  priority?: "urgent" | "high" | "medium" | "low" | "none";
  assigneeIds?: string[];
  addLabelIds?: string[];
  removeLabelIds?: string[];
  cycleId?: string | null;
  isArchived?: boolean;
}

export interface PmBulkRequest {
  ids: string[];
  patch: PmBulkPatch;
}

/** True when the patch names no field. `null`, `false` and `[]` DO name one. */
export function isPmBulkPatchEmpty(patch: PmBulkPatch): boolean {
  return PM_BULK_PATCH_KEYS.every((k) => patch[k] === undefined);
}
