/**
 * WARP-3521 — planning a work item into a cycle, through createWorkItem /
 * updateWorkItem, and the scoped list reader the cycle and module views use.
 *
 * What is pinned, in the order it matters:
 *   * the cycle is checked AND row-locked inside the item's own transaction
 *     (`lockAttachableCycle`) — a racing `completeCycle` cannot finish it under
 *     the write;
 *   * a refused cycle leaves NOTHING behind — no item, no sequence number, no
 *     activity (the transaction seam rolls back);
 *   * the activity row is the burndown's input, so its `oldValue` is read INSIDE
 *     the transaction, and a no-op change writes none;
 *   * taking an item OUT of a cycle is never guarded, even out of a completed one.
 *
 * Inherits the shared transaction seam (WARP-1570): pm.service.ts declares an
 * isolation level (deleteWorkItem), so this file may not hand-roll `$transaction`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTransactionSeam } from "../../__tests__/helpers/prisma-tx-harness.js";
import {
  PM_ERRORS,
  createWorkItem,
  listWorkItemsWhere,
  updateWorkItem,
} from "./pm.service.js";

type Row = Record<string, unknown>;

let seq = 0;
const uid = (p: string) => `${p}-${++seq}`;

interface CycleRow {
  id: string;
  projectId: string;
  status: "draft" | "active" | "completed";
}

function makeFake() {
  const project = {
    id: "p1",
    identifier: "PRJ",
    seqCounter: 0,
    states: [{ id: "s1", isDefault: true, sortOrder: 1, group: "unstarted", projectId: "p1" }],
    department: null,
  };
  const cycles: CycleRow[] = [
    { id: "cy-active", projectId: "p1", status: "active" },
    { id: "cy-other-active", projectId: "p1", status: "active" },
    { id: "cy-done", projectId: "p1", status: "completed" },
    { id: "cy-foreign", projectId: "p2", status: "active" },
  ];
  const items: Row[] = [];
  const activity: Row[] = [];
  const calls: string[] = [];
  const counts = { total: 0 };
  const lastFindMany: { args?: Row } = {};
  const lastCreate: { data?: Row } = {};

  const addItem = (over: Row = {}): Row => {
    const row: Row = {
      id: uid("wi"),
      projectId: "p1",
      sequenceId: items.length + 1,
      name: "an item",
      descriptionHtml: null,
      stateId: "s1",
      priority: "none",
      parentId: null,
      cycleId: null,
      departmentId: null,
      createdById: null,
      startDate: null,
      dueDate: null,
      sortOrder: 1,
      isCompleted: false,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    };
    items.push(row);
    return row;
  };

  const withIncludes = (row: Row): Row => ({
    ...row,
    state: null,
    assignees: [],
    labels: [],
    department: null,
    _count: { comments: 0, children: 0 },
  });

  const self: Record<string, unknown> = {
    pmProject: {
      findUnique: async () => ({ ...project }),
      update: async () => {
        project.seqCounter += 1;
        return { seqCounter: project.seqCounter };
      },
    },
    pmState: { findUnique: async () => null },
    pmLabel: { findMany: async () => [] },
    pmCycle: {
      updateMany: async ({ where }: { where: { id: string; projectId: string; status: { not: string } } }) => {
        calls.push("pmCycle.updateMany");
        const hit = cycles.filter(
          (c) => c.id === where.id && c.projectId === where.projectId && c.status !== where.status.not,
        );
        return { count: hit.length };
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const c = cycles.find((x) => x.id === where.id);
        return c ? { projectId: c.projectId, status: c.status } : null;
      },
    },
    pmWorkItem: {
      findUnique: async ({ where, select }: { where: { id: string }; select?: Row }) => {
        calls.push(select ? "pmWorkItem.findUnique(select)" : "pmWorkItem.findUnique");
        const r = items.find((i) => i.id === where.id);
        if (!r) return null;
        return select ? { cycleId: r.cycleId } : withIncludes(r);
      },
      create: async ({ data }: { data: Row }) => {
        calls.push("pmWorkItem.create");
        lastCreate.data = data;
        const row = addItem({ ...data });
        return row;
      },
      updateMany: async ({ where, data }: { where: { id: string; cycleId: string | null }; data: { cycleId: string | null } }) => {
        calls.push("pmWorkItem.updateMany(cycle)");
        const it = items.find((i) => i.id === where.id);
        if (!it || it.cycleId !== where.cycleId) return { count: 0 };
        it.cycleId = data.cycleId;
        return { count: 1 };
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        calls.push("pmWorkItem.update");
        const it = items.find((i) => i.id === where.id)!;
        const cyc = data.cycle as { connect?: { id: string }; disconnect?: boolean } | undefined;
        if (cyc) {
          it.cycleId = cyc.connect ? cyc.connect.id : null;
          delete data.cycle;
        }
        Object.assign(it, data);
        return it;
      },
      findMany: async (args: Row) => {
        lastFindMany.args = args;
        return [];
      },
      count: async () => counts.total,
    },
    pmActivity: {
      create: async ({ data }: { data: Row }) => {
        activity.push({ ...data });
        return {};
      },
    },
  };

  const seam = createTransactionSeam({ client: () => self, stores: { items, activity } });
  self.$transaction = seam.$transaction;

  return { prisma: self as never, items, activity, calls, addItem, project, counts, lastFindMany, lastCreate };
}

const cycleRows = (f: ReturnType<typeof makeFake>) =>
  f.activity.filter((a) => a.verb === "cycle_added" || a.verb === "cycle_removed");

beforeEach(() => {
  seq = 0;
});

describe("PM_ERRORS carries the cycle codes the work-item routes can raise", () => {
  it("is one vocabulary", () => {
    expect(PM_ERRORS.CYCLE_NOT_FOUND).toBe("cycle_not_found");
    expect(PM_ERRORS.INVALID_CYCLE).toBe("invalid_cycle");
    expect(PM_ERRORS.CYCLE_COMPLETED).toBe("cycle_completed");
  });
});

describe("createWorkItem with a cycle", () => {
  it("plans the new item into the cycle and records it, locking the cycle before the write", async () => {
    const f = makeFake();
    await createWorkItem(f.prisma, "u1", "p1", { name: "x", cycleId: "cy-active" });

    expect(f.items).toHaveLength(1);
    expect(f.items[0].cycleId).toBe("cy-active");
    expect(f.calls.indexOf("pmCycle.updateMany")).toBeGreaterThanOrEqual(0);
    expect(f.calls.indexOf("pmCycle.updateMany")).toBeLessThan(f.calls.indexOf("pmWorkItem.create"));
    expect(cycleRows(f)).toEqual([
      expect.objectContaining({
        verb: "cycle_added",
        field: "cycle",
        oldValue: null,
        newValue: "cy-active",
        actorId: "u1",
      }),
    ]);
  });

  it("without a cycle it touches no cycle, writes no cycleId key and no cycle activity", async () => {
    const f = makeFake();
    await createWorkItem(f.prisma, "u1", "p1", { name: "x" });
    expect(f.calls).not.toContain("pmCycle.updateMany");
    // not `cycleId: null` either: an absent key, so the column default stands
    expect(f.lastCreate.data).not.toHaveProperty("cycleId");
    expect(cycleRows(f)).toEqual([]);
  });

  it.each([
    ["a cycle of another project", "cy-foreign", "invalid_cycle"],
    ["a completed cycle", "cy-done", "cycle_completed"],
    ["a cycle that does not exist", "cy-ghost", "cycle_not_found"],
  ])("%s is refused (%s) and NOTHING is left behind", async (_label, cycleId, code) => {
    const f = makeFake();
    await expect(createWorkItem(f.prisma, "u1", "p1", { name: "x", cycleId })).rejects.toThrow(code);
    expect(f.items).toHaveLength(0);
    expect(f.activity).toHaveLength(0);
  });
});

describe("updateWorkItem with a cycle", () => {
  it("plans an item into a cycle: one cycle_added row, null → cycle", async () => {
    const f = makeFake();
    const it = f.addItem();
    await updateWorkItem(f.prisma, "u1", it.id as string, { cycleId: "cy-active" });
    expect(f.items[0].cycleId).toBe("cy-active");
    expect(cycleRows(f)).toEqual([
      expect.objectContaining({ verb: "cycle_added", field: "cycle", oldValue: null, newValue: "cy-active", actorId: "u1" }),
    ]);
  });

  it("moves an item A → B as ONE cycle_added row {A → B}", async () => {
    const f = makeFake();
    const it = f.addItem({ cycleId: "cy-active" });
    await updateWorkItem(f.prisma, "u1", it.id as string, { cycleId: "cy-other-active" });
    expect(f.items[0].cycleId).toBe("cy-other-active");
    expect(cycleRows(f)).toEqual([
      expect.objectContaining({ verb: "cycle_added", oldValue: "cy-active", newValue: "cy-other-active" }),
    ]);
  });

  it("null takes the item out: one cycle_removed row, cycle → null, and NO lock", async () => {
    const f = makeFake();
    const it = f.addItem({ cycleId: "cy-active" });
    await updateWorkItem(f.prisma, "u1", it.id as string, { cycleId: null });
    expect(f.items[0].cycleId).toBeNull();
    expect(f.calls).not.toContain("pmCycle.updateMany");
    expect(cycleRows(f)).toEqual([
      expect.objectContaining({ verb: "cycle_removed", field: "cycle", oldValue: "cy-active", newValue: null }),
    ]);
  });

  it("taking an item OUT of a COMPLETED cycle is allowed — only adding is guarded", async () => {
    const f = makeFake();
    const it = f.addItem({ cycleId: "cy-done" });
    await expect(updateWorkItem(f.prisma, "u1", it.id as string, { cycleId: null })).resolves.toBeTruthy();
    expect(f.items[0].cycleId).toBeNull();
  });

  it("the same cycle again is a no-op: no lock, no row, no write of the relation", async () => {
    const f = makeFake();
    const it = f.addItem({ cycleId: "cy-active" });
    await updateWorkItem(f.prisma, "u1", it.id as string, { cycleId: "cy-active" });
    expect(f.calls).not.toContain("pmCycle.updateMany");
    expect(cycleRows(f)).toEqual([]);
  });

  it("an update that does not mention the cycle never reads or locks one", async () => {
    const f = makeFake();
    const it = f.addItem({ cycleId: "cy-active" });
    await updateWorkItem(f.prisma, "u1", it.id as string, { name: "renamed" });
    expect(f.calls).not.toContain("pmCycle.updateMany");
    expect(f.calls).not.toContain("pmWorkItem.findUnique(select)");
    expect(f.items[0].cycleId).toBe("cy-active");
  });

  it.each([
    ["a cycle of another project", "cy-foreign", "invalid_cycle"],
    ["a completed cycle", "cy-done", "cycle_completed"],
    ["a cycle that does not exist", "cy-ghost", "cycle_not_found"],
  ])("%s is refused (%s) and the item is unchanged", async (_label, cycleId, code) => {
    const f = makeFake();
    const it = f.addItem({ cycleId: "cy-active", name: "before" });
    await expect(
      updateWorkItem(f.prisma, "u1", it.id as string, { cycleId, name: "after" }),
    ).rejects.toThrow(code);
    // the rename in the same request did not slip through either: one transaction
    expect(f.items[0]).toMatchObject({ cycleId: "cy-active", name: "before" });
    expect(f.activity).toHaveLength(0);
  });

  it("reads the item's CURRENT cycle inside the transaction — the activity's oldValue is what the row held then, not what the first read saw", async () => {
    const f = makeFake();
    const it = f.addItem({ cycleId: "cy-active" });
    // Between the request's first read and the transaction, completeCycle moved
    // the item on. The first read (outside the tx) still says cy-active.
    const wi = (f.prisma as unknown as { pmWorkItem: { findUnique: (a: Row) => Promise<Row | null> } }).pmWorkItem;
    const original = wi.findUnique;
    let outside = true;
    wi.findUnique = async (args: Row) => {
      const r = await original(args);
      if (r && !args.select && outside) {
        outside = false;
        // flip the stored value AFTER handing back the stale snapshot
        const snapshot = { ...r };
        it.cycleId = "cy-other-active";
        return snapshot;
      }
      return r;
    };
    await updateWorkItem(f.prisma, "u1", it.id as string, { cycleId: "cy-active" });
    // truth in the tx was cy-other-active, so planning it into cy-active IS a change
    expect(cycleRows(f)).toEqual([
      expect.objectContaining({ verb: "cycle_added", oldValue: "cy-other-active", newValue: "cy-active" }),
    ]);
  });

  it("re-reads and retries a stale cycle compare-and-set so concurrent moves chain their history", async () => {
    const f = makeFake();
    const it = f.addItem();
    const cycle = f.prisma as unknown as { pmCycle: { updateMany: (args: Row) => Promise<{ count: number }> } };
    const original = cycle.pmCycle.updateMany;
    let raced = false;
    cycle.pmCycle.updateMany = async (args: Row) => {
      const result = await original(args);
      if (!raced) {
        raced = true;
        // A concurrent move commits after our transaction read the old cycle.
        it.cycleId = "cy-other-active";
        f.activity.push({ verb: "cycle_added", oldValue: null, newValue: "cy-other-active" });
      }
      return result;
    };

    await updateWorkItem(f.prisma, "u1", it.id as string, { cycleId: "cy-active" });

    expect(it.cycleId).toBe("cy-active");
    expect(cycleRows(f)).toEqual([
      expect.objectContaining({ verb: "cycle_added", oldValue: null, newValue: "cy-other-active" }),
      expect.objectContaining({ verb: "cycle_added", oldValue: "cy-other-active", newValue: "cy-active" }),
    ]);
  });

  it("a cycle change and a state change in one request write both rows", async () => {
    const f = makeFake();
    const it = f.addItem();
    (f.prisma as unknown as { pmState: { findUnique: () => Promise<Row> } }).pmState.findUnique = async () => ({
      id: "s2",
      projectId: "p1",
      group: "started",
    });
    await updateWorkItem(f.prisma, "u1", it.id as string, { cycleId: "cy-active", stateId: "s2" });
    expect(f.activity.map((a) => a.verb).sort()).toEqual(["cycle_added", "state_changed"]);
  });
});

describe("listWorkItemsWhere", () => {
  it("ANDs the extra predicate with the project and the not-archived rule, and reports the exact total", async () => {
    const f = makeFake();
    f.counts.total = 417;
    const out = await listWorkItemsWhere(f.prisma, "p1", { cycleId: "cy-active" }, { perPage: 50, page: 3 });
    expect(out.total).toBe(417);
    expect(out.items).toEqual([]);
    expect(f.lastFindMany.args).toMatchObject({
      where: { AND: [{ projectId: "p1", isArchived: false }, { cycleId: "cy-active" }] },
      orderBy: [{ sortOrder: "asc" }, { sequenceId: "asc" }],
      skip: 100,
      take: 50,
    });
  });

  it("defaults to the 200 maximum — it is a scoped set, not the board", async () => {
    const f = makeFake();
    await listWorkItemsWhere(f.prisma, "p1", {}, {});
    expect(f.lastFindMany.args).toMatchObject({ skip: 0, take: 200 });
  });

  it("clamps a silly page size and page", async () => {
    const f = makeFake();
    await listWorkItemsWhere(f.prisma, "p1", {}, { perPage: 9999, page: -4 });
    expect(f.lastFindMany.args).toMatchObject({ skip: 0, take: 200 });
    await listWorkItemsWhere(f.prisma, "p1", {}, { perPage: 0 });
    expect(f.lastFindMany.args).toMatchObject({ take: 1 });
  });

  it("project_not_found", async () => {
    const f = makeFake();
    (f.prisma as unknown as { pmProject: { findUnique: () => Promise<null> } }).pmProject.findUnique = async () => null;
    await expect(listWorkItemsWhere(f.prisma, "nope", {}, {})).rejects.toThrow("project_not_found");
  });
});
