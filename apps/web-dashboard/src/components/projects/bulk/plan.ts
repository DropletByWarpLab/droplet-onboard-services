// WARP-3537 — a bulk action, planned before it is sent.
//
// The server decides what a batch MEANS (`pm-bulk.service.ts`); this decides what
// to ASK for and what to do about it afterwards, from the rows the table holds:
//
//   forward      only the items that are not already as asked. Sending the rest would
//                be a no-op the server drops anyway, and counting them in "Moved 12
//                items" would be a small lie.
//   optimistic   what the table shows at once (brief §4.4), per item.
//   undo         the steps that put each item back where IT was. Undo is not "the
//                reverse of the action": moving three items from three different states
//                to Done is undone by three different moves, and re-adding a label to
//                an item that already had it before is not putting anything back.
//                Items sharing a previous value share a step, so Undo is as few
//                requests as it can be.
//
// Pure, so every one of those is a test.

import type { PmBulkPatch } from "@droplet/shared-types";
import { PRIORITY } from "../config";
import type { PmLabel, PmState, PmWorkItem, Priority } from "../types";

export type BulkOp =
  | { kind: "state"; stateId: string }
  | { kind: "priority"; priority: Priority }
  /** REPLACES the assignee set; `[]` clears it. */
  | { kind: "assignees"; assigneeIds: string[] }
  | { kind: "label"; labelId: string; mode: "add" | "remove" }
  | { kind: "archive" };

export interface BulkLookups {
  states: PmState[];
  labels: PmLabel[];
  personName: (id: string) => string;
}

export interface BulkStep {
  ids: string[];
  patch: PmBulkPatch;
}

/** What the table draws for an item while a write is in flight. `hidden`: it leaves the view. */
export type ItemOverride = Partial<
  Pick<PmWorkItem, "stateId" | "state" | "priority" | "assignees" | "labels" | "name" | "dueDate">
> & { hidden?: true };

export interface BulkPlan {
  /** The one request to make; null when nothing would change. */
  forward: BulkStep | null;
  undo: BulkStep[];
  optimistic: Map<string, ItemOverride>;
  /** Changed items an Undo cannot restore (they had no state, which a bulk patch cannot set back). */
  unrestorable: number;
}

/** Items grouped by a key of their previous value, in first-seen order. */
function groupBy<T>(rows: readonly PmWorkItem[], key: (i: PmWorkItem) => string | null, value: (i: PmWorkItem) => T) {
  const groups = new Map<string, { ids: string[]; value: T }>();
  for (const it of rows) {
    const k = key(it);
    if (k === null) continue;
    const g = groups.get(k);
    if (g) g.ids.push(it.id);
    else groups.set(k, { ids: [it.id], value: value(it) });
  }
  return [...groups.values()];
}

const setKey = (ids: readonly string[]) => [...ids].sort().join("\u0000");

export function planBulkOp(op: BulkOp, items: readonly PmWorkItem[], lookups: BulkLookups): BulkPlan {
  const none: BulkPlan = { forward: null, undo: [], optimistic: new Map(), unrestorable: 0 };
  const optimistic = new Map<string, ItemOverride>();
  const ids = (rows: readonly PmWorkItem[]) => rows.map((i) => i.id);

  switch (op.kind) {
    case "state": {
      const changing = items.filter((i) => i.stateId !== op.stateId);
      if (changing.length === 0) return none;
      const state = lookups.states.find((s) => s.id === op.stateId);
      for (const it of changing) optimistic.set(it.id, state ? { stateId: op.stateId, state } : { stateId: op.stateId });
      return {
        forward: { ids: ids(changing), patch: { stateId: op.stateId } },
        undo: groupBy(changing, (i) => i.stateId, (i) => i.stateId!).map((g) => ({ ids: g.ids, patch: { stateId: g.value } })),
        optimistic,
        unrestorable: changing.filter((i) => i.stateId === null).length,
      };
    }
    case "priority": {
      const changing = items.filter((i) => i.priority !== op.priority);
      if (changing.length === 0) return none;
      for (const it of changing) optimistic.set(it.id, { priority: op.priority });
      return {
        forward: { ids: ids(changing), patch: { priority: op.priority } },
        undo: groupBy(changing, (i) => i.priority, (i) => i.priority).map((g) => ({ ids: g.ids, patch: { priority: g.value } })),
        optimistic,
        unrestorable: 0,
      };
    }
    case "assignees": {
      const want = setKey(op.assigneeIds);
      const changing = items.filter((i) => setKey(i.assignees) !== want);
      if (changing.length === 0) return none;
      for (const it of changing) optimistic.set(it.id, { assignees: [...op.assigneeIds] });
      return {
        forward: { ids: ids(changing), patch: { assigneeIds: [...op.assigneeIds] } },
        undo: groupBy(changing, (i) => setKey(i.assignees), (i) => [...i.assignees].sort()).map((g) => ({ ids: g.ids, patch: { assigneeIds: g.value } })),
        optimistic,
        unrestorable: 0,
      };
    }
    case "label": {
      const has = (i: PmWorkItem) => i.labels.some((l) => l.id === op.labelId);
      const adding = op.mode === "add";
      const changing = items.filter((i) => (adding ? !has(i) : has(i)));
      if (changing.length === 0) return none;
      const label = lookups.labels.find((l) => l.id === op.labelId);
      for (const it of changing) {
        if (adding) optimistic.set(it.id, label ? { labels: [...it.labels, label] } : {});
        else optimistic.set(it.id, { labels: it.labels.filter((l) => l.id !== op.labelId) });
      }
      return {
        forward: { ids: ids(changing), patch: adding ? { addLabelIds: [op.labelId] } : { removeLabelIds: [op.labelId] } },
        undo: [{ ids: ids(changing), patch: adding ? { removeLabelIds: [op.labelId] } : { addLabelIds: [op.labelId] } }],
        optimistic,
        unrestorable: 0,
      };
    }
    case "archive": {
      if (items.length === 0) return none;
      for (const it of items) optimistic.set(it.id, { hidden: true });
      return {
        forward: { ids: ids(items), patch: { isArchived: true } },
        undo: [{ ids: ids(items), patch: { isArchived: false } }],
        optimistic,
        unrestorable: 0,
      };
    }
  }
}

const itemsOf = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;

/** The toast's sentence: what happened, to how many. Sentence case, no exclamation (brief §6). */
export function describeOp(op: BulkOp, n: number, lookups: BulkLookups): string {
  switch (op.kind) {
    case "state":
      return `Moved ${itemsOf(n)} to ${lookups.states.find((s) => s.id === op.stateId)?.name ?? "that state"}`;
    case "priority":
      return `Set priority to ${PRIORITY[op.priority].label} on ${itemsOf(n)}`;
    case "assignees":
      if (op.assigneeIds.length === 0) return `Cleared the assignee on ${itemsOf(n)}`;
      if (op.assigneeIds.length === 1) return `Assigned ${itemsOf(n)} to ${lookups.personName(op.assigneeIds[0])}`;
      return `Set ${op.assigneeIds.length} assignees on ${itemsOf(n)}`;
    case "label": {
      const name = lookups.labels.find((l) => l.id === op.labelId)?.name ?? "label";
      return op.mode === "add" ? `Added the label ${name} to ${itemsOf(n)}` : `Removed the label ${name} from ${itemsOf(n)}`;
    }
    case "archive":
      return `Archived ${itemsOf(n)}`;
  }
}
