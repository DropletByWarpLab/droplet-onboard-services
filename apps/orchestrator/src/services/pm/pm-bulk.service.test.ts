/**
 * WARP-3537 — the bulk edit's DECISIONS, with no database: who may touch which
 * item, whether a state / label / cycle belongs to the items it is applied to,
 * and — the part everything else hangs off — which writes and which activity rows
 * a patch turns into.
 *
 * What the transaction DOES with them (all or nothing, in one commit, under a
 * race) is `__tests__/pm-bulk.pg.test.ts`'s claim; this file is about the plan.
 */
import { describe, it, expect } from "vitest";
import {
  PM_BULK_ERRORS,
  PmBulkError,
  assertBulkReferences,
  canWriteItem,
  planBulk,
  type BulkItem,
  type BulkRefs,
} from "./pm-bulk.service.js";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const ACTOR = "u-actor";

function item(id: string, over: Partial<BulkItem> = {}): BulkItem {
  return {
    id,
    projectId: "p1",
    stateId: "todo",
    priority: "none",
    cycleId: null,
    isArchived: false,
    assigneeIds: [],
    labelIds: [],
    ...over,
  };
}

const noRefs: BulkRefs = { state: null, cycle: null, labels: new Map() };
const plan = (items: BulkItem[], patch: Parameters<typeof planBulk>[1], refs: BulkRefs = noRefs) =>
  planBulk(items, patch, refs, ACTOR, NOW);

// ── who may touch what ──────────────────────────────────────────────────────

describe("canWriteItem", () => {
  const unassigned = item("a");
  const mine = item("b", { assigneeIds: ["u-guest"] });

  it.each(["owner", "admin", "family"])("lets a %s change any item, any field", (role) => {
    expect(canWriteItem({ userId: "u1", role }, unassigned, { priority: "high", isArchived: true })).toBe(true);
  });

  it.each(["member", "viewer", "service", "nobody"])("refuses a %s everything", (role) => {
    expect(canWriteItem({ userId: "u1", role }, mine, { stateId: "x" })).toBe(false);
  });

  it("lets a guest move the state of an item assigned to them — the one share WARP-3369 grants", () => {
    expect(canWriteItem({ userId: "u-guest", role: "guest" }, mine, { stateId: "done" })).toBe(true);
  });

  it("refuses a guest an item that is not theirs", () => {
    expect(canWriteItem({ userId: "u-guest", role: "guest" }, unassigned, { stateId: "done" })).toBe(false);
  });

  it("refuses a guest every other field of an item that IS theirs — a share is not edit rights", () => {
    const guest = { userId: "u-guest", role: "guest" };
    expect(canWriteItem(guest, mine, { stateId: "done", priority: "high" })).toBe(false);
    expect(canWriteItem(guest, mine, { priority: "high" })).toBe(false);
    expect(canWriteItem(guest, mine, { isArchived: true })).toBe(false);
    expect(canWriteItem(guest, mine, { assigneeIds: [] })).toBe(false);
  });
});

// ── references ──────────────────────────────────────────────────────────────

describe("assertBulkReferences", () => {
  const items = [item("a"), item("b"), item("c", { projectId: "p2" })];

  it("accepts a state, labels and a cycle that belong to every item's project", () => {
    expect(() =>
      assertBulkReferences(
        [item("a"), item("b")],
        { stateId: "s", addLabelIds: ["l1"], removeLabelIds: ["l2"], cycleId: "cy" },
        {
          state: { id: "s", projectId: "p1", group: "started" },
          cycle: { id: "cy", projectId: "p1" },
          labels: new Map([
            ["l1", { id: "l1", projectId: "p1" }],
            ["l2", { id: "l2", projectId: "p1" }],
          ]),
        },
      ),
    ).not.toThrow();
  });

  it("names the items a state does not belong to — invalid_state, with exactly their ids", () => {
    const fn = () =>
      assertBulkReferences(items, { stateId: "s" }, { ...noRefs, state: { id: "s", projectId: "p1", group: "started" } });
    expect(fn).toThrow(PmBulkError);
    try {
      fn();
    } catch (e) {
      expect((e as PmBulkError).code).toBe("invalid_state");
      expect((e as PmBulkError).ids).toEqual(["c"]);
    }
  });

  it("names the items a label (to add, or to remove) does not belong to — invalid_label", () => {
    for (const patch of [{ addLabelIds: ["l"] }, { removeLabelIds: ["l"] }]) {
      try {
        assertBulkReferences(items, patch, { ...noRefs, labels: new Map([["l", { id: "l", projectId: "p2" }]]) });
        throw new Error("did not throw");
      } catch (e) {
        expect((e as PmBulkError).code).toBe("invalid_label");
        expect((e as PmBulkError).ids).toEqual(["a", "b"]);
      }
    }
  });

  it("names the items a cycle does not belong to — invalid_cycle", () => {
    try {
      assertBulkReferences(items, { cycleId: "cy" }, { ...noRefs, cycle: { id: "cy", projectId: "p2" } });
      throw new Error("did not throw");
    } catch (e) {
      expect((e as PmBulkError).code).toBe(PM_BULK_ERRORS.INVALID_CYCLE);
      expect((e as PmBulkError).ids).toEqual(["a", "b"]);
    }
  });

  it("clearing the cycle (null) needs no cycle to belong to anything", () => {
    expect(() => assertBulkReferences(items, { cycleId: null }, noRefs)).not.toThrow();
  });

  it("a reference that is not a row at all is a 404 code, not a 422: state_not_found, label_not_found, cycle_not_found", () => {
    const code = (fn: () => void): string => {
      try {
        fn();
      } catch (e) {
        return (e as PmBulkError).code;
      }
      return "did not throw";
    };
    expect(code(() => assertBulkReferences(items, { stateId: "gone" }, noRefs))).toBe("state_not_found");
    expect(code(() => assertBulkReferences(items, { addLabelIds: ["gone"] }, noRefs))).toBe("label_not_found");
    expect(code(() => assertBulkReferences(items, { removeLabelIds: ["gone"] }, noRefs))).toBe("label_not_found");
    expect(code(() => assertBulkReferences(items, { cycleId: "gone" }, noRefs))).toBe("cycle_not_found");
  });
});

// ── the plan ────────────────────────────────────────────────────────────────

describe("planBulk: state", () => {
  const started = { id: "doing", projectId: "p1", group: "started" as const };
  const done = { id: "done", projectId: "p1", group: "completed" as const };

  it("changes only the items not already there, and writes a state_changed row for each", () => {
    const p = plan([item("a"), item("b", { stateId: "doing" })], { stateId: "doing" }, { ...noRefs, state: started });
    expect(p.state).toMatchObject({ ids: ["a"], stateId: "doing" });
    expect(p.changed).toEqual(["a"]);
    expect(p.activity).toEqual([
      { workItemId: "a", actorId: ACTOR, verb: "state_changed", field: "state", oldValue: "todo", newValue: "doing" },
    ]);
  });

  it("stamps completion when the state is terminal, as updateWorkItem does", () => {
    const p = plan([item("a")], { stateId: "done" }, { ...noRefs, state: done });
    expect(p.state).toEqual({ ids: ["a"], stateId: "done", isCompleted: true, completedAt: NOW });
  });

  it("clears completion when the state is not", () => {
    const p = plan([item("a", { stateId: "done" })], { stateId: "doing" }, { ...noRefs, state: started });
    expect(p.state).toEqual({ ids: ["a"], stateId: "doing", isCompleted: false, completedAt: null });
  });

  it("records an item that had no state as oldValue null", () => {
    const p = plan([item("a", { stateId: null })], { stateId: "doing" }, { ...noRefs, state: started });
    expect(p.activity[0]).toMatchObject({ oldValue: null, newValue: "doing" });
  });
});

describe("planBulk: priority", () => {
  it("is an `updated` row with field priority, like the single-item path writes", () => {
    const p = plan([item("a", { priority: "low" }), item("b", { priority: "high" })], { priority: "high" });
    expect(p.priority).toEqual({ ids: ["a"], priority: "high" });
    expect(p.activity).toEqual([
      { workItemId: "a", actorId: ACTOR, verb: "updated", field: "priority", oldValue: "low", newValue: "high" },
    ]);
  });
});

describe("planBulk: assignees (replace)", () => {
  it("adds who is missing and removes who is no longer wanted, one row per person", () => {
    const p = plan([item("a", { assigneeIds: ["x", "y"] })], { assigneeIds: ["y", "z"] });
    expect(p.assigneeAdds).toEqual([{ workItemId: "a", userId: "z" }]);
    expect(p.assigneeRemoves).toEqual([{ workItemId: "a", userIds: ["x"] }]);
    expect(p.activity).toEqual([
      { workItemId: "a", actorId: ACTOR, verb: "assigned", field: "assignees", oldValue: null, newValue: "z" },
      { workItemId: "a", actorId: ACTOR, verb: "unassigned", field: "assignees", oldValue: "x", newValue: null },
    ]);
  });

  it("treats the same people in another order as no change", () => {
    const p = plan([item("a", { assigneeIds: ["x", "y"] })], { assigneeIds: ["y", "x"] });
    expect(p.changed).toEqual([]);
    expect(p.activity).toEqual([]);
  });

  it("[] clears everyone", () => {
    const p = plan([item("a", { assigneeIds: ["x"] }), item("b")], { assigneeIds: [] });
    expect(p.assigneeRemoves).toEqual([{ workItemId: "a", userIds: ["x"] }]);
    expect(p.assigneeAdds).toEqual([]);
    expect(p.changed).toEqual(["a"]);
  });

  it("a repeated id in the request is one person", () => {
    const p = plan([item("a")], { assigneeIds: ["z", "z"] });
    expect(p.assigneeAdds).toEqual([{ workItemId: "a", userId: "z" }]);
    expect(p.activity).toHaveLength(1);
  });
});

describe("planBulk: labels (add / remove)", () => {
  it("adds only what an item lacks and removes only what it has", () => {
    const p = plan([item("a", { labelIds: ["l1"] }), item("b", { labelIds: ["l1", "l2"] })], {
      addLabelIds: ["l1", "l3"],
      removeLabelIds: ["l2"],
    });
    expect(p.labelAdds).toEqual([
      { workItemId: "a", labelId: "l3" },
      { workItemId: "b", labelId: "l3" },
    ]);
    expect(p.labelRemoves).toEqual([{ workItemId: "b", labelIds: ["l2"] }]);
    expect(p.activity.map((r) => [r.workItemId, r.verb, r.oldValue, r.newValue])).toEqual([
      ["a", "label_added", null, "l3"],
      ["b", "label_added", null, "l3"],
      ["b", "label_removed", "l2", null],
    ]);
    expect(p.activity.every((r) => r.field === "labels" && r.actorId === ACTOR)).toBe(true);
  });
});

describe("planBulk: cycle", () => {
  const cy = { id: "c2", projectId: "p1" };

  it("putting an item in a cycle is cycle_added, and says which cycle it left", () => {
    const p = plan([item("a"), item("b", { cycleId: "c1" })], { cycleId: "c2" }, { ...noRefs, cycle: cy });
    expect(p.cycle).toEqual({ ids: ["a", "b"], cycleId: "c2" });
    expect(p.activity.map((r) => [r.verb, r.field, r.oldValue, r.newValue])).toEqual([
      ["cycle_added", "cycle", null, "c2"],
      ["cycle_added", "cycle", "c1", "c2"],
    ]);
  });

  it("null takes the item out of its cycle: cycle_removed", () => {
    const p = plan([item("a", { cycleId: "c1" }), item("b")], { cycleId: null });
    expect(p.cycle).toEqual({ ids: ["a"], cycleId: null });
    expect(p.activity).toEqual([
      { workItemId: "a", actorId: ACTOR, verb: "cycle_removed", field: "cycle", oldValue: "c1", newValue: null },
    ]);
  });

  it("an item already in the cycle is not a change", () => {
    expect(plan([item("a", { cycleId: "c2" })], { cycleId: "c2" }, { ...noRefs, cycle: cy }).changed).toEqual([]);
  });
});

describe("planBulk: archive", () => {
  it("archiving stamps archivedAt and writes `archived`", () => {
    const p = plan([item("a"), item("b", { isArchived: true })], { isArchived: true });
    expect(p.archive).toEqual({ ids: ["a"], isArchived: true, archivedAt: NOW });
    expect(p.activity).toEqual([
      { workItemId: "a", actorId: ACTOR, verb: "archived", field: "isArchived", oldValue: "false", newValue: "true" },
    ]);
  });

  it("restoring clears archivedAt and writes `restored`", () => {
    const p = plan([item("a", { isArchived: true })], { isArchived: false });
    expect(p.archive).toEqual({ ids: ["a"], isArchived: false, archivedAt: null });
    expect(p.activity).toEqual([
      { workItemId: "a", actorId: ACTOR, verb: "restored", field: "isArchived", oldValue: "true", newValue: "false" },
    ]);
  });
});

describe("planBulk: several fields at once", () => {
  const started = { id: "doing", projectId: "p1", group: "started" as const };

  it("writes one row per changed field per item — and none for a field an item already holds", () => {
    const items = [item("a"), item("b", { priority: "urgent" }), item("c", { stateId: "doing", priority: "urgent" })];
    const p = plan(items, { stateId: "doing", priority: "urgent" }, { ...noRefs, state: started });
    const rows = p.activity.map((r) => `${r.workItemId}:${r.field}`);
    expect(rows).toEqual(["a:state", "a:priority", "b:state"]);
    expect(p.changed).toEqual(["a", "b"]);
  });

  it("follows the request's item order, field by field", () => {
    const p = plan([item("z"), item("a")], { priority: "high", isArchived: true });
    expect(p.activity.map((r) => `${r.workItemId}:${r.field}`)).toEqual(["z:priority", "z:isArchived", "a:priority", "a:isArchived"]);
  });

  it("lists items changed ONLY through a join table, so their updatedAt still moves", () => {
    const p = plan([item("a"), item("b", { priority: "none" })], { assigneeIds: ["x"], priority: "high" });
    // a changed through the assignee join AND the priority column; both columns
    // move updatedAt on their own.
    expect(p.touchOnly).toEqual([]);

    const q = plan([item("a", { priority: "high" })], { assigneeIds: ["x"], priority: "high" });
    expect(q.touchOnly).toEqual(["a"]);
  });

  it("is empty when nothing changes", () => {
    const p = plan([item("a", { priority: "high", isArchived: true })], { priority: "high", isArchived: true });
    expect(p.changed).toEqual([]);
    expect(p.activity).toEqual([]);
    expect(p.touchOnly).toEqual([]);
    expect(p.priority).toBeNull();
    expect(p.archive).toBeNull();
  });
});
