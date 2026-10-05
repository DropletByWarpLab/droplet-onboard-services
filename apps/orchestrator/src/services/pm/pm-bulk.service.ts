/**
 * WARP-3537 (WS-6b) — bulk edit: `POST /api/pm/work-items/bulk`.
 *
 * ONE transaction, ALL OR NOTHING. A batch either changes every item it names or
 * changes none, and says why: an id that is not a work item (404), an item the
 * caller may not touch (403, listing every such id), a state / label / cycle that
 * does not belong to the items it is applied to (422, listing them), a lost race
 * (409). There is no partial result to reason about, and no half-applied
 * selection for an Undo to chase.
 *
 * ── the shape of the code ───────────────────────────────────────────────────
 *
 * The DECISIONS are pure functions over plain snapshots — `canWriteItem`,
 * `assertBulkReferences`, `planBulk` — so every branch is a unit test with no
 * database. `bulkUpdateWorkItems` is the thin I/O around them: load, decide,
 * write a handful of set-based statements, append the activity, read the result
 * back, all inside one SERIALIZABLE transaction (check-then-write: the plan is
 * computed from what was read, so what was read must still be true at commit —
 * a writer that got in between aborts this one with 409 instead of leaving an
 * activity row whose oldValue is a lie).
 *
 * ── activity ────────────────────────────────────────────────────────────────
 *
 * One row per changed field per item, written through pm.service's
 * `writeActivity` in the same transaction — ADR-069 §7: PmActivity is the outbox,
 * and a row exists exactly when its change committed. A field an item already
 * holds is not a change and writes nothing. The verbs are the ones the
 * single-item path already uses, so a feed, a notifier and WS-2's timeline read a
 * bulk change and a single one the same way:
 *
 *   state      state_changed, field "state"            (notified, as ever)
 *   priority   updated,       field "priority"
 *   assignees  assigned / unassigned, field "assignees" (one per person)
 *   labels     label_added / label_removed, field "labels" (one per label)
 *   cycle      cycle_added / cycle_removed, field "cycle"
 *   archive    archived / restored, field "isArchived"
 *
 * `label_*`, `cycle_*`, `archived` and `restored` are the board-hygiene verbs the
 * notifier deliberately does not interrupt anyone for (activity-notify.service.ts
 * header), and the notifier coalesces `assigned` / `state_changed` per recipient
 * per tick — a 500-item bulk assign is one digest, not 500 toasts.
 *
 * ── who may touch what ──────────────────────────────────────────────────────
 *
 * `canWriteItem` is the PER-ITEM check. The route admits owner / admin / family
 * (what PATCH admits) and those may touch every item — PM is household-shared —
 * so for them it never says no. It exists so this endpoint can never do more than
 * the same number of single-item calls would: the one per-record rule PM has is
 * WARP-3369's — an external guest may move the STATE of an item ASSIGNED to them,
 * and nothing else — and it is enforced here, in the service, rather than assumed
 * from the route's role list. The route does not admit a guest, and
 * `modules/guest-shares.ts` does not list this path; if either ever changes, the
 * rule is already the one that holds. WS-12 (a service desk's rows are invisible
 * to /api/pm) is the next rule that belongs in this function.
 */
import type { $Enums, Prisma, PrismaClient } from "@prisma/client";
import { PM_BULK_MAX_IDS, type PmBulkPatch } from "@droplet/shared-types";
import { SERIALIZABLE_TX } from "../../lib/prisma-tx.js";
import { DEPARTMENT_SELECT } from "./pm-department.js";
import { nudgeOutbox } from "./pm-outbox.js";
import {
  PM_ERRORS,
  WORK_ITEM_INCLUDE,
  assertAssignable,
  isPrismaCode,
  mapWorkItem,
  writeActivity,
  type ActivityInput,
  type ApiWorkItem,
} from "./pm.service.js";

/** The roles that may write PM data — what `routes/pm/native.ts` calls WRITE. */
export const PM_BULK_WRITER_ROLES = ["owner", "admin", "family"] as const;

export const PM_BULK_ERRORS = {
  /** 403 — the caller may not change these items. `ids` is every such id. */
  FORBIDDEN: "work_items_forbidden",
  INVALID_LABEL: "invalid_label",
  CYCLE_NOT_FOUND: "cycle_not_found",
  /** 422 — the cycle exists but belongs to another project than these items. */
  INVALID_CYCLE: "invalid_cycle",
} as const;

/**
 * A refusal that names the work items it is about. Extends Error with the stable
 * code as its message — exactly what `mapServiceError` switches on elsewhere —
 * and carries the ids so the caller can say which ones.
 */
export class PmBulkError extends Error {
  readonly code: string;
  readonly ids: string[];
  constructor(code: string, ids: string[] = []) {
    super(code);
    this.name = "PmBulkError";
    this.code = code;
    this.ids = ids;
  }
}

export interface BulkActor {
  /** The caller's User.id — a person: the route refuses every principal without one. */
  userId: string;
  role: string;
}

/** What planning needs to know about an item, and nothing it could not know. */
export interface BulkItem {
  id: string;
  projectId: string;
  stateId: string | null;
  priority: $Enums.PmPriority;
  cycleId: string | null;
  isArchived: boolean;
  assigneeIds: string[];
  labelIds: string[];
}

/** The rows the patch names, as read. `null` / missing = the id named no row. */
export interface BulkRefs {
  state: { id: string; projectId: string; group: $Enums.PmStateGroup } | null;
  cycle: { id: string; projectId: string } | null;
  labels: Map<string, { id: string; projectId: string }>;
}

// ── who may touch what ──────────────────────────────────────────────────────

export function canWriteItem(actor: BulkActor, item: BulkItem, patch: PmBulkPatch): boolean {
  if ((PM_BULK_WRITER_ROLES as readonly string[]).includes(actor.role)) return true;
  if (actor.role === "guest") {
    // WARP-3369: assigned to them → they may move its state. Nothing else.
    const onlyState = Object.entries(patch).every(([k, v]) => v === undefined || k === "stateId");
    return onlyState && item.assigneeIds.includes(actor.userId);
  }
  return false;
}

const seesEveryItem = (actor: BulkActor): boolean =>
  (PM_BULK_WRITER_ROLES as readonly string[]).includes(actor.role);

// ── do the references belong to the items they are applied to ───────────────

/**
 * A state, a label and a cycle are PER PROJECT. A selection that spans projects
 * cannot be moved to "Done" (each project has its own), and a label from one
 * project is not a label of another — the same invariant `createWorkItem` /
 * `updateWorkItem` hold one item at a time, here held for all of them or none.
 * A reference that is not a row at all is 404; one that belongs elsewhere is 422
 * and names the items it does not fit.
 */
export function assertBulkReferences(items: BulkItem[], patch: PmBulkPatch, refs: BulkRefs): void {
  if (patch.stateId !== undefined) {
    if (!refs.state) throw new PmBulkError(PM_ERRORS.STATE_NOT_FOUND);
    const state = refs.state;
    const bad = items.filter((i) => i.projectId !== state.projectId).map((i) => i.id);
    if (bad.length > 0) throw new PmBulkError(PM_ERRORS.INVALID_STATE, bad);
  }

  const labelIds = [...(patch.addLabelIds ?? []), ...(patch.removeLabelIds ?? [])];
  if (labelIds.length > 0) {
    const bad = new Set<string>();
    for (const id of labelIds) {
      const label = refs.labels.get(id);
      if (!label) throw new PmBulkError(PM_ERRORS.LABEL_NOT_FOUND);
      for (const i of items) if (i.projectId !== label.projectId) bad.add(i.id);
    }
    if (bad.size > 0) throw new PmBulkError(PM_BULK_ERRORS.INVALID_LABEL, items.filter((i) => bad.has(i.id)).map((i) => i.id));
  }

  if (typeof patch.cycleId === "string") {
    if (!refs.cycle) throw new PmBulkError(PM_BULK_ERRORS.CYCLE_NOT_FOUND);
    const cycle = refs.cycle;
    const bad = items.filter((i) => i.projectId !== cycle.projectId).map((i) => i.id);
    if (bad.length > 0) throw new PmBulkError(PM_BULK_ERRORS.INVALID_CYCLE, bad);
  }
}

// ── the plan ────────────────────────────────────────────────────────────────

export interface BulkPlan {
  /** Items with at least one effective change, in request order. */
  changed: string[];
  state: { ids: string[]; stateId: string; isCompleted: boolean; completedAt: Date | null } | null;
  priority: { ids: string[]; priority: $Enums.PmPriority } | null;
  cycle: { ids: string[]; cycleId: string | null } | null;
  archive: { ids: string[]; isArchived: boolean; archivedAt: Date | null } | null;
  assigneeAdds: Array<{ workItemId: string; userId: string }>;
  assigneeRemoves: Array<{ workItemId: string; userIds: string[] }>;
  labelAdds: Array<{ workItemId: string; labelId: string }>;
  labelRemoves: Array<{ workItemId: string; labelIds: string[] }>;
  /** Changed ONLY through a join table: `updatedAt` must still move, and nothing else would move it. */
  touchOnly: string[];
  /** One row per changed field per item, in request order, field by field. */
  activity: ActivityInput[];
}

/**
 * What a patch turns into for these items: which columns to set on which ids,
 * which join rows to add or remove, and the activity rows that record them. Pure:
 * `now` and `actorId` come in, nothing is read.
 *
 * Completion follows the state exactly as `updateWorkItem` does (WARP-884): into a
 * completed / cancelled state stamps `isCompleted` + `completedAt`, out of one
 * clears both — and only for an item whose state actually changes.
 */
export function planBulk(
  items: BulkItem[],
  patch: PmBulkPatch,
  refs: BulkRefs,
  actorId: string | null,
  now: Date,
): BulkPlan {
  const plan: BulkPlan = {
    changed: [],
    state: null,
    priority: null,
    cycle: null,
    archive: null,
    assigneeAdds: [],
    assigneeRemoves: [],
    labelAdds: [],
    labelRemoves: [],
    touchOnly: [],
    activity: [],
  };

  const wantAssignees = patch.assigneeIds === undefined ? undefined : [...new Set(patch.assigneeIds)];
  const addLabels = [...new Set(patch.addLabelIds ?? [])];
  const removeLabels = [...new Set(patch.removeLabelIds ?? [])];

  const row = (workItemId: string, verb: ActivityInput["verb"], field: string, oldValue: string | null, newValue: string | null) =>
    plan.activity.push({ workItemId, actorId, verb, field, oldValue, newValue });

  for (const it of items) {
    let ownColumn = false;
    let joined = false;

    if (patch.stateId !== undefined && it.stateId !== patch.stateId) {
      const terminal = refs.state?.group === "completed" || refs.state?.group === "cancelled";
      plan.state ??= { ids: [], stateId: patch.stateId, isCompleted: terminal, completedAt: terminal ? now : null };
      plan.state.ids.push(it.id);
      row(it.id, "state_changed", "state", it.stateId, patch.stateId);
      ownColumn = true;
    }

    if (patch.priority !== undefined && it.priority !== patch.priority) {
      plan.priority ??= { ids: [], priority: patch.priority };
      plan.priority.ids.push(it.id);
      row(it.id, "updated", "priority", it.priority, patch.priority);
      ownColumn = true;
    }

    if (wantAssignees !== undefined) {
      const have = new Set(it.assigneeIds);
      const want = new Set(wantAssignees);
      const adds = wantAssignees.filter((u) => !have.has(u));
      const removes = it.assigneeIds.filter((u) => !want.has(u));
      for (const userId of adds) {
        plan.assigneeAdds.push({ workItemId: it.id, userId });
        row(it.id, "assigned", "assignees", null, userId);
      }
      if (removes.length > 0) plan.assigneeRemoves.push({ workItemId: it.id, userIds: removes });
      for (const userId of removes) row(it.id, "unassigned", "assignees", userId, null);
      if (adds.length > 0 || removes.length > 0) joined = true;
    }

    if (addLabels.length > 0 || removeLabels.length > 0) {
      const have = new Set(it.labelIds);
      for (const labelId of addLabels) {
        if (have.has(labelId)) continue;
        plan.labelAdds.push({ workItemId: it.id, labelId });
        row(it.id, "label_added", "labels", null, labelId);
        joined = true;
      }
      const removes = removeLabels.filter((l) => have.has(l));
      if (removes.length > 0) plan.labelRemoves.push({ workItemId: it.id, labelIds: removes });
      for (const labelId of removes) {
        row(it.id, "label_removed", "labels", labelId, null);
        joined = true;
      }
    }

    if (patch.cycleId !== undefined && it.cycleId !== patch.cycleId) {
      plan.cycle ??= { ids: [], cycleId: patch.cycleId };
      plan.cycle.ids.push(it.id);
      if (patch.cycleId === null) row(it.id, "cycle_removed", "cycle", it.cycleId, null);
      else row(it.id, "cycle_added", "cycle", it.cycleId, patch.cycleId);
      ownColumn = true;
    }

    if (patch.isArchived !== undefined && it.isArchived !== patch.isArchived) {
      plan.archive ??= { ids: [], isArchived: patch.isArchived, archivedAt: patch.isArchived ? now : null };
      plan.archive.ids.push(it.id);
      row(it.id, patch.isArchived ? "archived" : "restored", "isArchived", String(it.isArchived), String(patch.isArchived));
      ownColumn = true;
    }

    if (ownColumn || joined) plan.changed.push(it.id);
    if (joined && !ownColumn) plan.touchOnly.push(it.id);
  }

  return plan;
}

// ── the transaction ─────────────────────────────────────────────────────────

export interface BulkResult {
  /** Items that actually changed — `work_items.length` minus the ones already as asked. */
  changed: number;
  /** Every item the request named, in request order, after the change. */
  work_items: ApiWorkItem[];
}

export async function bulkUpdateWorkItems(
  prisma: PrismaClient,
  actor: BulkActor,
  input: { ids: string[]; patch: PmBulkPatch },
  now: Date = new Date(),
): Promise<BulkResult> {
  const ids = [...new Set(input.ids)];
  if (ids.length === 0) return { changed: 0, work_items: [] };
  if (ids.length > PM_BULK_MAX_IDS) throw new PmBulkError("too_many_items");
  const { patch } = input;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const found = await tx.pmWorkItem.findMany({
        // WS-12 stores tickets as PmWorkItems in SERVICE_DESK projects. The PM
        // bulk endpoint must apply the same parent-kind boundary as every other
        // /api/pm reader before planning, so ticket ids behave like missing IDs.
        where: { id: { in: ids }, project: { kind: "PROJECT" } },
        select: {
          id: true,
          projectId: true,
          stateId: true,
          priority: true,
          cycleId: true,
          isArchived: true,
          assignees: { select: { userId: true } },
          labels: { select: { labelId: true } },
        },
      });
      const byId = new Map(found.map((r) => [r.id, r]));
      const items: BulkItem[] = ids.flatMap((id) => {
        const r = byId.get(id);
        return r
          ? [
              {
                id: r.id,
                projectId: r.projectId,
                stateId: r.stateId,
                priority: r.priority,
                cycleId: r.cycleId,
                isArchived: r.isArchived,
                assigneeIds: r.assignees.map((a) => a.userId),
                labelIds: r.labels.map((l) => l.labelId),
              },
            ]
          : [];
      });

      // Permission first, and for an actor who cannot see every item an unknown id
      // is "forbidden", not "not found": the answer must not tell them which ids
      // exist (guest-share.ts answers the same way for the same reason).
      const itemById = new Map(items.map((i) => [i.id, i]));
      const forbidden = ids.filter((id) => {
        const item = itemById.get(id);
        return item ? !canWriteItem(actor, item, patch) : !seesEveryItem(actor);
      });
      if (forbidden.length > 0) throw new PmBulkError(PM_BULK_ERRORS.FORBIDDEN, forbidden);
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length > 0) throw new PmBulkError(PM_ERRORS.WORK_ITEM_NOT_FOUND, missing);

      const labelIds = [...new Set([...(patch.addLabelIds ?? []), ...(patch.removeLabelIds ?? [])])];
      const [state, labels, cycle] = await Promise.all([
        patch.stateId !== undefined
          ? tx.pmState.findUnique({ where: { id: patch.stateId }, select: { id: true, projectId: true, group: true } })
          : null,
        labelIds.length > 0
          ? tx.pmLabel.findMany({ where: { id: { in: labelIds } }, select: { id: true, projectId: true } })
          : [],
        typeof patch.cycleId === "string"
          ? tx.pmCycle.findUnique({ where: { id: patch.cycleId }, select: { id: true, projectId: true } })
          : null,
      ]);
      const refs: BulkRefs = { state, cycle, labels: new Map(labels.map((l) => [l.id, l])) };
      assertBulkReferences(items, patch, refs);

      const plan = planBulk(items, patch, refs, actor.userId, now);
      // Match the single-item path: newly added assignees must be active
      // people. Validate inside this transaction before any batch write;
      // retaining or removing a previously assigned leaver stays possible.
      await assertAssignable(tx, plan.assigneeAdds.map((a) => a.userId));

      if (plan.state) {
        await tx.pmWorkItem.updateMany({
          where: { id: { in: plan.state.ids } },
          data: { stateId: plan.state.stateId, isCompleted: plan.state.isCompleted, completedAt: plan.state.completedAt },
        });
      }
      if (plan.priority) {
        await tx.pmWorkItem.updateMany({ where: { id: { in: plan.priority.ids } }, data: { priority: plan.priority.priority } });
      }
      if (plan.cycle) {
        await tx.pmWorkItem.updateMany({ where: { id: { in: plan.cycle.ids } }, data: { cycleId: plan.cycle.cycleId } });
      }
      if (plan.archive) {
        await tx.pmWorkItem.updateMany({
          where: { id: { in: plan.archive.ids } },
          data: { isArchived: plan.archive.isArchived, archivedAt: plan.archive.archivedAt },
        });
      }
      if (plan.assigneeRemoves.length > 0) {
        await tx.pmWorkItemAssignee.deleteMany({
          where: { OR: plan.assigneeRemoves.map((r) => ({ workItemId: r.workItemId, userId: { in: r.userIds } })) },
        });
      }
      if (plan.assigneeAdds.length > 0) {
        await tx.pmWorkItemAssignee.createMany({ data: plan.assigneeAdds, skipDuplicates: true });
      }
      if (plan.labelRemoves.length > 0) {
        await tx.pmWorkItemLabel.deleteMany({
          where: { OR: plan.labelRemoves.map((r) => ({ workItemId: r.workItemId, labelId: { in: r.labelIds } })) },
        });
      }
      if (plan.labelAdds.length > 0) {
        await tx.pmWorkItemLabel.createMany({ data: plan.labelAdds, skipDuplicates: true });
      }
      if (plan.touchOnly.length > 0) {
        await tx.pmWorkItem.updateMany({ where: { id: { in: plan.touchOnly } }, data: { updatedAt: now } });
      }
      // Last, and in this transaction: the history of a change exists exactly when
      // the change does.
      await writeActivity(tx, plan.activity.map((entry) => ({ ...entry, nudge: false })));

      const rows = await tx.pmWorkItem.findMany({
        where: { id: { in: ids }, project: { kind: "PROJECT" } },
        include: {
          ...WORK_ITEM_INCLUDE,
          project: { select: { identifier: true, department: { select: DEPARTMENT_SELECT } } },
        } satisfies Prisma.PmWorkItemInclude,
      });
      const mapped = new Map(rows.map((r) => [r.id, mapWorkItem(r, r.project.identifier, r.project.department)]));
      return { changed: plan.changed.length, work_items: ids.flatMap((id) => (mapped.has(id) ? [mapped.get(id)!] : [])) };
    }, SERIALIZABLE_TX);
    if (result.changed > 0) nudgeOutbox();
    return result;
  } catch (err) {
    // The SERIALIZABLE loser: somebody else changed one of these rows between our
    // read and our commit. Nothing was applied; the route answers 409 and the
    // client may simply send it again.
    if (isPrismaCode(err, "P2034")) throw new Error(PM_ERRORS.CONCURRENT_MUTATION);
    throw err;
  }
}
