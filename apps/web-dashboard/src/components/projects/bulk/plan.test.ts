/**
 * WARP-3537 — a bulk action, planned before it is sent: which of the selected items
 * really change, what the table shows at once (optimistic, brief §4.4), the words of
 * the toast, and — the part that makes "Undo" honest — the steps that put each
 * item back where IT was, not where the first one was.
 */
import { describe, it, expect } from "vitest";
import { describeOp, planBulkOp, type BulkLookups } from "./plan";
import type { PmLabel, PmState, PmWorkItem } from "../types";

const TODO: PmState = { id: "todo", projectId: "p1", name: "Todo", group: "unstarted", color: null, sortOrder: 1, isDefault: true };
const DOING: PmState = { id: "doing", projectId: "p1", name: "In Progress", group: "started", color: null, sortOrder: 2, isDefault: false };
const DONE: PmState = { id: "done", projectId: "p1", name: "Done", group: "completed", color: null, sortOrder: 3, isDefault: false };
const BUG: PmLabel = { id: "l-bug", projectId: "p1", name: "Bug", color: null };
const DOCS: PmLabel = { id: "l-docs", projectId: "p1", name: "Docs", color: null };

function item(n: number, over: Partial<PmWorkItem> = {}): PmWorkItem {
  return {
    id: `w${n}`,
    projectId: "p1",
    sequenceId: n,
    key: `INBOX-${n}`,
    name: `Item ${n}`,
    descriptionHtml: null,
    stateId: TODO.id,
    state: TODO,
    priority: "none",
    parentId: null,
    cycleId: null,
    department: null,
    assignees: [],
    labels: [],
    startDate: null,
    dueDate: null,
    sortOrder: n,
    completedAt: null,
    createdById: null,
    commentCount: 0,
    subItemCount: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

const lookups: BulkLookups = {
  states: [TODO, DOING, DONE],
  labels: [BUG, DOCS],
  personName: (id) => ({ ana: "Ana", bo: "Bo" })[id] ?? "Former member",
};

describe("state", () => {
  const items = [item(1), item(2, { stateId: DOING.id, state: DOING }), item(3, { stateId: DONE.id, state: DONE })];

  it("sends only the items that are not already there", () => {
    const p = planBulkOp({ kind: "state", stateId: DONE.id }, items, lookups);
    expect(p.forward).toEqual({ ids: ["w1", "w2"], patch: { stateId: "done" } });
  });

  it("undoes each item to its OWN previous state: one step per distinct previous value", () => {
    const p = planBulkOp({ kind: "state", stateId: DONE.id }, items, lookups);
    expect(p.undo).toEqual([
      { ids: ["w1"], patch: { stateId: "todo" } },
      { ids: ["w2"], patch: { stateId: "doing" } },
    ]);
  });

  it("draws the new state at once, on exactly the items that change", () => {
    const p = planBulkOp({ kind: "state", stateId: DONE.id }, items, lookups);
    expect([...p.optimistic.keys()]).toEqual(["w1", "w2"]);
    expect(p.optimistic.get("w1")).toMatchObject({ stateId: "done", state: DONE });
  });

  it("cannot restore an item that had no state (a bulk patch cannot clear one), and says how many", () => {
    const p = planBulkOp({ kind: "state", stateId: DONE.id }, [item(1, { stateId: null, state: null }), item(2)], lookups);
    expect(p.forward!.ids).toEqual(["w1", "w2"]);
    expect(p.undo).toEqual([{ ids: ["w2"], patch: { stateId: "todo" } }]);
    expect(p.unrestorable).toBe(1);
  });
});

describe("priority", () => {
  it("sends the items that differ and undoes to each one's own priority", () => {
    const p = planBulkOp({ kind: "priority", priority: "high" }, [item(1), item(2, { priority: "low" }), item(3, { priority: "high" }), item(4, { priority: "low" })], lookups);
    expect(p.forward).toEqual({ ids: ["w1", "w2", "w4"], patch: { priority: "high" } });
    expect(p.undo).toEqual([
      { ids: ["w1"], patch: { priority: "none" } },
      { ids: ["w2", "w4"], patch: { priority: "low" } },
    ]);
    expect(p.optimistic.get("w2")).toEqual({ priority: "high" });
  });
});

describe("assignees (replace)", () => {
  it("replaces the set, and undoes each item to the set IT had — an order-independent match groups them", () => {
    const items = [item(1, { assignees: ["ana"] }), item(2, { assignees: ["bo", "ana"] }), item(3, { assignees: ["ana", "bo"] }), item(4, { assignees: ["bo"] })];
    const p = planBulkOp({ kind: "assignees", assigneeIds: ["bo"] }, items, lookups);
    // w4 already has exactly ["bo"].
    expect(p.forward).toEqual({ ids: ["w1", "w2", "w3"], patch: { assigneeIds: ["bo"] } });
    expect(p.undo).toEqual([
      { ids: ["w1"], patch: { assigneeIds: ["ana"] } },
      { ids: ["w2", "w3"], patch: { assigneeIds: ["ana", "bo"] } },
    ]);
    expect(p.optimistic.get("w1")).toEqual({ assignees: ["bo"] });
  });

  it("clearing everyone is a replace with []", () => {
    const p = planBulkOp({ kind: "assignees", assigneeIds: [] }, [item(1, { assignees: ["ana"] }), item(2)], lookups);
    expect(p.forward).toEqual({ ids: ["w1"], patch: { assigneeIds: [] } });
    expect(p.undo).toEqual([{ ids: ["w1"], patch: { assigneeIds: ["ana"] } }]);
  });
});

describe("label", () => {
  it("adds only where it is missing, and undo takes it off only from those", () => {
    const p = planBulkOp({ kind: "label", labelId: BUG.id, mode: "add" }, [item(1), item(2, { labels: [BUG] }), item(3, { labels: [DOCS] })], lookups);
    expect(p.forward).toEqual({ ids: ["w1", "w3"], patch: { addLabelIds: ["l-bug"] } });
    expect(p.undo).toEqual([{ ids: ["w1", "w3"], patch: { removeLabelIds: ["l-bug"] } }]);
    expect(p.optimistic.get("w3")).toEqual({ labels: [DOCS, BUG] });
  });

  it("removes only where it is, and undo puts it back only there", () => {
    const p = planBulkOp({ kind: "label", labelId: BUG.id, mode: "remove" }, [item(1), item(2, { labels: [BUG, DOCS] })], lookups);
    expect(p.forward).toEqual({ ids: ["w2"], patch: { removeLabelIds: ["l-bug"] } });
    expect(p.undo).toEqual([{ ids: ["w2"], patch: { addLabelIds: ["l-bug"] } }]);
    expect(p.optimistic.get("w2")).toEqual({ labels: [DOCS] });
  });
});

describe("archive", () => {
  it("archives, hides the rows at once, and restores on undo", () => {
    const p = planBulkOp({ kind: "archive" }, [item(1), item(2)], lookups);
    expect(p.forward).toEqual({ ids: ["w1", "w2"], patch: { isArchived: true } });
    expect(p.undo).toEqual([{ ids: ["w1", "w2"], patch: { isArchived: false } }]);
    expect(p.optimistic.get("w1")).toEqual({ hidden: true });
  });
});

describe("nothing to do", () => {
  it("has no forward step when every selected item is already as asked", () => {
    const p = planBulkOp({ kind: "priority", priority: "none" }, [item(1), item(2)], lookups);
    expect(p.forward).toBeNull();
    expect(p.undo).toEqual([]);
    expect(p.optimistic.size).toBe(0);
  });
});

describe("describeOp: the words of the toast (sentence case, no exclamation, items counted)", () => {
  it("names what happened and to how many", () => {
    expect(describeOp({ kind: "state", stateId: DONE.id }, 12, lookups)).toBe("Moved 12 items to Done");
    expect(describeOp({ kind: "state", stateId: DONE.id }, 1, lookups)).toBe("Moved 1 item to Done");
    expect(describeOp({ kind: "priority", priority: "urgent" }, 3, lookups)).toBe("Set priority to Urgent on 3 items");
    expect(describeOp({ kind: "assignees", assigneeIds: ["ana"] }, 4, lookups)).toBe("Assigned 4 items to Ana");
    expect(describeOp({ kind: "assignees", assigneeIds: [] }, 2, lookups)).toBe("Cleared the assignee on 2 items");
    expect(describeOp({ kind: "assignees", assigneeIds: ["ana", "bo"] }, 2, lookups)).toBe("Set 2 assignees on 2 items");
    expect(describeOp({ kind: "label", labelId: BUG.id, mode: "add" }, 5, lookups)).toBe("Added the label Bug to 5 items");
    expect(describeOp({ kind: "label", labelId: BUG.id, mode: "remove" }, 1, lookups)).toBe("Removed the label Bug from 1 item");
    expect(describeOp({ kind: "archive" }, 2, lookups)).toBe("Archived 2 items");
  });
});
