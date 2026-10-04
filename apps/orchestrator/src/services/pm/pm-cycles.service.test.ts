/**
 * WARP-3521 — pm-cycles.service unit cover.
 *
 * The fake models the three database behaviours the service leans on, because a
 * Prisma stub that merely accepts the calls proves nothing about them:
 *
 *   * the partial unique index `PmCycle_projectId_active_key` — a second active
 *     cycle in a project throws P2002, exactly like Postgres;
 *   * `updateMany` as a compare-and-set — it only touches rows its WHERE still
 *     matches, which is what makes "start" and "complete" single-winner;
 *   * transaction atomicity — a throw rolls everything back (the shared seam,
 *     WARP-1570, which also records the isolation level asked for).
 *
 * The real Postgres is the only proof of the index, the triggers and the
 * concurrency, and `pm-cycles-modules.pg.test.ts` is where that lives.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { REPEATABLE_READ_TX, SERIALIZABLE_TX } from "../../lib/prisma-tx.js";
import {
  createTransactionSeam,
  expectAllTransactionsAt,
} from "../../__tests__/helpers/prisma-tx-harness.js";
import * as pmService from "./pm.service.js";
import {
  completeCycle,
  createCycle,
  deleteCycle,
  getCycle,
  getCycleBurndown,
  listBacklog,
  listCycleWorkItems,
  listCycles,
  startCycle,
  updateCycle,
} from "./pm-cycles.service.js";

vi.mock("./pm.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pm.service.js")>();
  return { ...actual, listWorkItemsWhere: vi.fn() };
});

type Row = Record<string, unknown>;

let seq = 0;
const uid = (p: string) => `${p}-${++seq}`;

function prismaError(code: string): Error & { code: string } {
  const e = new Error(`Prisma ${code}`) as Error & { code: string };
  e.name = "PrismaClientKnownRequestError";
  e.code = code;
  return e;
}

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

interface CycleRow {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  startDate: Date | null;
  endDate: Date | null;
  status: "draft" | "active" | "completed";
  completedAt: Date | null;
  carriedOverCount: number;
  createdAt: Date;
  updatedAt: Date;
}
interface ItemRow {
  id: string;
  projectId: string;
  cycleId: string | null;
  isCompleted: boolean;
  isArchived: boolean;
  estimate: number | null;
  stateId: string | null;
}
interface ActRow {
  workItemId: string;
  actorId: string | null;
  verb: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  createdAt: Date;
}

function makeFake() {
  const projects = [{ id: "p1" }, { id: "p2" }];
  const states: Array<{ id: string; projectId: string; group: string }> = [
    { id: "s-todo", projectId: "p1", group: "unstarted" },
    { id: "s-doing", projectId: "p1", group: "started" },
    { id: "s-done", projectId: "p1", group: "completed" },
    { id: "s-cancelled", projectId: "p1", group: "cancelled" },
  ];
  const cycles: CycleRow[] = [];
  const items: ItemRow[] = [];
  const activity: ActRow[] = [];
  const calls: string[] = [];

  const addCycle = (over: Partial<CycleRow> = {}): CycleRow => {
    const row: CycleRow = {
      id: uid("cy"),
      projectId: "p1",
      name: "Sprint",
      description: null,
      startDate: d("2026-10-05"),
      endDate: d("2026-10-16"),
      status: "draft",
      completedAt: null,
      carriedOverCount: 0,
      createdAt: new Date(2026, 9, 1),
      updatedAt: new Date(2026, 9, 1),
      ...over,
    };
    cycles.push(row);
    return row;
  };
  const addItem = (over: Partial<ItemRow> = {}): ItemRow => {
    const row: ItemRow = {
      id: uid("wi"),
      projectId: "p1",
      cycleId: null,
      isCompleted: false,
      isArchived: false,
      estimate: null,
      stateId: "s-todo",
      ...over,
    };
    items.push(row);
    return row;
  };

  /** The partial unique index: at most one active cycle per project. */
  const assertSingleActive = (candidate: CycleRow, nextStatus: string) => {
    if (
      nextStatus === "active" &&
      cycles.some((c) => c.id !== candidate.id && c.projectId === candidate.projectId && c.status === "active")
    ) {
      throw prismaError("P2002");
    }
  };

  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === "object" && !(v instanceof Date)) {
        const o = v as { in?: unknown[]; not?: unknown };
        if (o.in) return o.in.includes(row[k]);
        if ("not" in o) return row[k] !== o.not;
      }
      return row[k] === v;
    });

  const self: Record<string, unknown> = {
    pmProject: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        projects.find((p) => p.id === where.id) ?? null,
    },

    pmState: {
      findMany: async ({ where }: { where: Row }) => states.filter((s) => matches(s as Row, where)),
    },

    pmCycle: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        calls.push("pmCycle.findUnique");
        const c = cycles.find((x) => x.id === where.id);
        return c ? { ...c } : null;
      },
      findFirst: async ({ where }: { where: Row }) => {
        const c = cycles.find((x) => matches(x as unknown as Row, where));
        return c ? { ...c } : null;
      },
      findMany: async ({ where }: { where: Row }) =>
        cycles.filter((x) => matches(x as unknown as Row, where)).map((c) => ({ ...c })),
      create: async ({ data }: { data: Partial<CycleRow> }) => {
        const row = {
          id: uid("cy"),
          description: null,
          startDate: null,
          endDate: null,
          status: "draft",
          completedAt: null,
          carriedOverCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        } as CycleRow;
        cycles.push(row);
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<CycleRow> }) => {
        calls.push("pmCycle.update");
        const c = cycles.find((x) => x.id === where.id);
        if (!c) throw prismaError("P2025");
        if (data.status) assertSingleActive(c, data.status);
        Object.assign(c, data, { updatedAt: new Date() });
        return { ...c };
      },
      updateMany: async ({ where, data }: { where: Row; data: Partial<CycleRow> }) => {
        calls.push("pmCycle.updateMany");
        // Real Prisma issues no UPDATE for an empty `data` and answers count 0 —
        // indistinguishable from "no row matched" (WS-5 review S3).
        if (Object.keys(data).length === 0) return { count: 0 };
        const hits = cycles.filter((x) => matches(x as unknown as Row, where));
        for (const c of hits) {
          if (data.status) assertSingleActive(c, data.status);
          Object.assign(c, data, { updatedAt: data.updatedAt ?? new Date() });
        }
        return { count: hits.length };
      },
      delete: async ({ where }: { where: { id: string } }) => {
        calls.push("pmCycle.delete");
        const i = cycles.findIndex((x) => x.id === where.id);
        if (i < 0) throw prismaError("P2025");
        const [gone] = cycles.splice(i, 1);
        // ON DELETE SET NULL
        for (const it of items) if (it.cycleId === gone.id) it.cycleId = null;
        return { ...gone };
      },
    },

    pmWorkItem: {
      findMany: async ({ where }: { where: Row }) => {
        calls.push("pmWorkItem.findMany");
        return items.filter((x) => matches(x as unknown as Row, where)).map((x) => ({
          ...x,
          state: x.stateId ? { group: states.find((s) => s.id === x.stateId)?.group ?? null } : null,
        }));
      },
      updateMany: async ({ where, data }: { where: Row; data: Partial<ItemRow> }) => {
        calls.push("pmWorkItem.updateMany");
        const hits = items.filter((x) => matches(x as unknown as Row, where));
        for (const it of hits) Object.assign(it, data);
        return { count: hits.length };
      },
    },

    pmActivity: {
      createMany: async ({ data }: { data: Array<Omit<ActRow, "createdAt">> }) => {
        calls.push("pmActivity.createMany");
        for (const r of data) activity.push({ createdAt: new Date(), ...r });
        return { count: data.length };
      },
      findMany: async ({ where }: { where: Row }) => {
        const verbs = (where.verb as { in?: string[] } | string | undefined) ?? undefined;
        const or = where.OR as Array<{ oldValue?: string; newValue?: string }> | undefined;
        const ids = (where.workItemId as { in?: string[] } | undefined)?.in;
        return activity
          .filter((a) => {
            if (typeof verbs === "string" && a.verb !== verbs) return false;
            if (typeof verbs === "object" && verbs?.in && !verbs.in.includes(a.verb)) return false;
            if (ids && !ids.includes(a.workItemId)) return false;
            if (or && !or.some((c) => (c.oldValue && a.oldValue === c.oldValue) || (c.newValue && a.newValue === c.newValue))) {
              return false;
            }
            return true;
          })
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((a) => ({ ...a }));
      },
    },
  };

  const seam = createTransactionSeam({
    client: () => self,
    stores: { cycles, items, activity },
  });
  self.$transaction = seam.$transaction;

  return { prisma: self as never, cycles, items, activity, calls, seam, addCycle, addItem };
}

beforeEach(() => {
  seq = 0;
  vi.mocked(pmService.listWorkItemsWhere).mockReset();
});

// ── create / update ───────────────────────────────────────────────────────────

describe("createCycle", () => {
  it("creates a draft cycle and answers dates as YYYY-MM-DD", async () => {
    const f = makeFake();
    const cycle = await createCycle(f.prisma, "p1", {
      name: "Sprint 12",
      description: "Ship the thing",
      startDate: d("2026-10-05"),
      endDate: d("2026-10-16"),
    });
    expect(cycle).toMatchObject({
      projectId: "p1",
      name: "Sprint 12",
      description: "Ship the thing",
      startDate: "2026-10-05",
      endDate: "2026-10-16",
      status: "draft",
      completedAt: null,
      carriedOverCount: 0,
    });
    expect(cycle.progress).toEqual({
      total: 0,
      completed: 0,
      cancelled: 0,
      totalEstimate: 0,
      completedEstimate: 0,
      cancelledEstimate: 0,
    });
    expect(f.cycles).toHaveLength(1);
  });

  it("dates are optional on a draft", async () => {
    const f = makeFake();
    const cycle = await createCycle(f.prisma, "p1", { name: "Someday" });
    expect(cycle.startDate).toBeNull();
    expect(cycle.endDate).toBeNull();
  });

  it("project_not_found for an unknown project", async () => {
    const f = makeFake();
    await expect(createCycle(f.prisma, "nope", { name: "x" })).rejects.toThrow("project_not_found");
  });

  it("invalid_dates when the end is before the start, with the reason", async () => {
    const f = makeFake();
    const err = await createCycle(f.prisma, "p1", {
      name: "x",
      startDate: d("2026-10-16"),
      endDate: d("2026-10-05"),
    }).catch((e) => e);
    expect(err.message).toBe("invalid_dates");
    expect(err.details).toMatchObject({ reason: "end_before_start" });
    expect(f.cycles).toHaveLength(0);
  });

  it("invalid_dates when the cycle is longer than a year and a day", async () => {
    const f = makeFake();
    const err = await createCycle(f.prisma, "p1", {
      name: "x",
      startDate: d("2026-01-01"),
      endDate: d("2027-01-02"), // 367 days inclusive
    }).catch((e) => e);
    expect(err.message).toBe("invalid_dates");
    expect(err.details).toMatchObject({ reason: "too_long" });
  });

  it("accepts a cycle of exactly 366 days", async () => {
    const f = makeFake();
    await expect(
      createCycle(f.prisma, "p1", { name: "x", startDate: d("2028-01-01"), endDate: d("2028-12-31") }),
    ).resolves.toBeTruthy();
  });
});

describe("updateCycle", () => {
  it("changes only what it is given", async () => {
    const f = makeFake();
    const c = f.addCycle({ name: "Old", description: "keep" });
    const updated = await updateCycle(f.prisma, c.id, { name: "New" });
    expect(updated.name).toBe("New");
    expect(updated.description).toBe("keep");
    expect(updated.startDate).toBe("2026-10-05");
  });

  it("null clears a description", async () => {
    const f = makeFake();
    const c = f.addCycle({ description: "x" });
    expect((await updateCycle(f.prisma, c.id, { description: null })).description).toBeNull();
  });

  it("validates the MERGED dates, not only the ones in the request", async () => {
    const f = makeFake();
    const c = f.addCycle({ startDate: d("2026-10-05"), endDate: d("2026-10-16") });
    // moving only the end to before the existing start is still end-before-start
    await expect(updateCycle(f.prisma, c.id, { endDate: d("2026-10-01") })).rejects.toThrow("invalid_dates");
  });

  it("cycle_not_found for an unknown cycle", async () => {
    const f = makeFake();
    await expect(updateCycle(f.prisma, "nope", { name: "x" })).rejects.toThrow("cycle_not_found");
    // an empty patch on an unknown cycle is still a 404, not a quiet success
    await expect(updateCycle(f.prisma, "nope", {})).rejects.toThrow("cycle_not_found");
  });

  it("an empty patch is a no-op that answers the cycle, not a 409 (review S3)", async () => {
    const f = makeFake();
    const c = f.addCycle({ name: "Same", description: "keep", status: "active" });
    const before = { ...f.cycles[0] };
    const got = await updateCycle(f.prisma, c.id, {});
    expect(got).toMatchObject({ id: c.id, name: "Same", description: "keep", status: "active" });
    // nothing was written: no UPDATE, and the row (updatedAt included) is untouched
    expect(f.calls).not.toContain("pmCycle.updateMany");
    expect(f.calls).not.toContain("pmCycle.update");
    expect(f.cycles[0]).toEqual(before);
    // fields that are all `undefined` are the same thing as no fields
    await expect(
      updateCycle(f.prisma, c.id, { name: undefined, description: undefined, startDate: undefined, endDate: undefined }),
    ).resolves.toMatchObject({ name: "Same" });
  });

  it("an empty patch on a completed cycle is also a no-op (it touches no date)", async () => {
    const f = makeFake();
    const c = f.addCycle({ status: "completed", completedAt: new Date() });
    await expect(updateCycle(f.prisma, c.id, {})).resolves.toMatchObject({ status: "completed" });
  });

  it("an edit that loses a race with a start or a completion applies NOTHING and says concurrent_mutation", async () => {
    // The rules were decided on the status the service read (a draft may have
    // its dates changed). The write is conditioned on that status still holding,
    // so a cycle completed in between cannot take the date change.
    const f = makeFake();
    const c = f.addCycle({ status: "draft" });
    const model = (f.prisma as unknown as { pmCycle: { findUnique: (a: unknown) => Promise<unknown> } }).pmCycle;
    const original = model.findUnique;
    model.findUnique = async (a: unknown) => {
      const snapshot = await original(a);
      f.cycles[0].status = "completed"; // flips AFTER the service has read 'draft'
      return snapshot;
    };
    await expect(updateCycle(f.prisma, c.id, { endDate: d("2026-10-30") })).rejects.toThrow("concurrent_mutation");
    expect(f.cycles[0].endDate).toEqual(d("2026-10-16"));
  });

  it("a completed cycle keeps its dates — they are history — but may be renamed", async () => {
    const f = makeFake();
    const c = f.addCycle({ status: "completed", completedAt: new Date() });
    await expect(updateCycle(f.prisma, c.id, { endDate: d("2026-10-30") })).rejects.toThrow("cycle_completed");
    await expect(updateCycle(f.prisma, c.id, { startDate: null })).rejects.toThrow("cycle_completed");
    await expect(updateCycle(f.prisma, c.id, { name: "Renamed" })).resolves.toMatchObject({ name: "Renamed" });
  });

  it("an active cycle cannot lose a date — the burndown needs both", async () => {
    const f = makeFake();
    const c = f.addCycle({ status: "active" });
    await expect(updateCycle(f.prisma, c.id, { endDate: null })).rejects.toThrow("cycle_dates_required");
    await expect(updateCycle(f.prisma, c.id, { startDate: null })).rejects.toThrow("cycle_dates_required");
    // but extending it is fine
    await expect(updateCycle(f.prisma, c.id, { endDate: d("2026-10-23") })).resolves.toMatchObject({
      endDate: "2026-10-23",
    });
  });
});

// ── start ─────────────────────────────────────────────────────────────────────

describe("startCycle", () => {
  it("draft → active", async () => {
    const f = makeFake();
    const c = f.addCycle();
    const started = await startCycle(f.prisma, c.id);
    expect(started.status).toBe("active");
    expect(f.cycles[0].status).toBe("active");
  });

  it("needs both dates", async () => {
    const f = makeFake();
    const noEnd = f.addCycle({ endDate: null });
    const noStart = f.addCycle({ startDate: null, projectId: "p2" });
    await expect(startCycle(f.prisma, noEnd.id)).rejects.toThrow("cycle_dates_required");
    await expect(startCycle(f.prisma, noStart.id)).rejects.toThrow("cycle_dates_required");
    expect(noEnd.status).toBe("draft");
  });

  it("only a draft can be started", async () => {
    const f = makeFake();
    const active = f.addCycle({ status: "active" });
    const done = f.addCycle({ status: "completed", projectId: "p2" });
    await expect(startCycle(f.prisma, active.id)).rejects.toThrow("cycle_not_draft");
    await expect(startCycle(f.prisma, done.id)).rejects.toThrow("cycle_not_draft");
  });

  it("cycle_not_found for an unknown cycle", async () => {
    const f = makeFake();
    await expect(startCycle(f.prisma, "nope")).rejects.toThrow("cycle_not_found");
  });

  it("refuses a second active cycle in the project, and names the one in the way", async () => {
    const f = makeFake();
    f.addCycle({ status: "active", name: "Sprint 11" });
    const next = f.addCycle({ name: "Sprint 12" });
    const err = await startCycle(f.prisma, next.id).catch((e) => e);
    expect(err.message).toBe("cycle_already_active");
    expect(err.details).toMatchObject({ activeCycleName: "Sprint 11" });
    expect(next.status).toBe("draft");
  });

  it("another project's active cycle is no obstacle", async () => {
    const f = makeFake();
    f.addCycle({ status: "active", projectId: "p2" });
    const mine = f.addCycle();
    await expect(startCycle(f.prisma, mine.id)).resolves.toMatchObject({ status: "active" });
  });

  it("two starts that race past the pre-check lose to the unique index, as cycle_already_active", async () => {
    const f = makeFake();
    const a = f.addCycle({ name: "A" });
    const b = f.addCycle({ name: "B" });
    // Both pass the friendly pre-check (nothing is active yet)...
    const results = await Promise.allSettled([
      startCycle(f.prisma, a.id),
      startCycle(f.prisma, b.id),
    ]);
    // ...and the index lets exactly one through.
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason.message).toBe("cycle_already_active");
    expect(f.cycles.filter((c) => c.status === "active")).toHaveLength(1);
  });
});

// ── complete ──────────────────────────────────────────────────────────────────

describe("completeCycle", () => {
  /** A fresh read: the seam restores rollback snapshots as NEW row objects, so a
   *  reference captured before the transaction would silently go stale. */
  const cycleOf = (f: ReturnType<typeof makeFake>, id: string) => f.items.find((i) => i.id === id)!.cycleId;

  function scenario() {
    const f = makeFake();
    const cycle = f.addCycle({ status: "active", name: "Sprint 12" });
    const done = f.addItem({ cycleId: cycle.id, isCompleted: true, stateId: "s-done" });
    const cancelled = f.addItem({ cycleId: cycle.id, isCompleted: true, stateId: "s-cancelled" });
    const open1 = f.addItem({ cycleId: cycle.id });
    const open2 = f.addItem({ cycleId: cycle.id, stateId: "s-doing" });
    const archivedOpen = f.addItem({ cycleId: cycle.id, isArchived: true });
    const elsewhere = f.addItem({ cycleId: null });
    return { f, cycle, done, cancelled, open1, open2, archivedOpen, elsewhere };
  }

  it("moves every incomplete item to the backlog and leaves the finished ones where they are", async () => {
    const { f, cycle, done, cancelled, open1, open2, archivedOpen, elsewhere } = scenario();
    const result = await completeCycle(f.prisma, "u1", cycle.id, { moveIncompleteTo: null });

    expect(open1.cycleId).toBeNull();
    expect(open2.cycleId).toBeNull();
    // hidden is not finished: an archived open item must not stay stranded either
    expect(archivedOpen.cycleId).toBeNull();
    expect(done.cycleId).toBe(cycle.id);
    expect(cancelled.cycleId).toBe(cycle.id);
    expect(elsewhere.cycleId).toBeNull();

    expect(result.moved).toEqual({ count: 3, to: null });
    expect(result.cycle).toMatchObject({ status: "completed", carriedOverCount: 2 });
    expect(result.cycle.completedAt).toEqual(expect.any(String));
    // AC: never an incomplete item left attached to the completed cycle
    expect(f.items.filter((i) => i.cycleId === cycle.id && !i.isCompleted)).toEqual([]);
  });

  it("writes ONE activity row per moved item, and none for the ones that stay", async () => {
    const { f, cycle, open1, open2, archivedOpen } = scenario();
    await completeCycle(f.prisma, "u1", cycle.id, { moveIncompleteTo: null });
    expect(f.activity).toHaveLength(3);
    expect(f.activity.map((a) => a.workItemId).sort()).toEqual([open1.id, open2.id, archivedOpen.id].sort());
    for (const a of f.activity) {
      expect(a).toMatchObject({
        actorId: "u1",
        verb: "cycle_removed",
        field: "cycle",
        oldValue: cycle.id,
        newValue: null,
      });
    }
  });

  it("can carry the unfinished work into another cycle — one `cycle_added` row each, from → to", async () => {
    const { f, cycle, open1, open2, archivedOpen } = scenario();
    const next = f.addCycle({ name: "Sprint 13", startDate: d("2026-10-19"), endDate: d("2026-10-30") });
    const result = await completeCycle(f.prisma, "u1", cycle.id, { moveIncompleteTo: next.id });

    expect(open1.cycleId).toBe(next.id);
    expect(open2.cycleId).toBe(next.id);
    expect(archivedOpen.cycleId).toBe(next.id);
    expect(result.moved).toEqual({ count: 3, to: next.id });
    expect(f.activity).toHaveLength(3);
    for (const a of f.activity) {
      expect(a).toMatchObject({ verb: "cycle_added", field: "cycle", oldValue: cycle.id, newValue: next.id });
    }
  });

  it("completing with nothing to move is fine", async () => {
    const f = makeFake();
    const cycle = f.addCycle({ status: "active" });
    f.addItem({ cycleId: cycle.id, isCompleted: true, stateId: "s-done" });
    const result = await completeCycle(f.prisma, "u1", cycle.id, { moveIncompleteTo: null });
    expect(result.moved).toEqual({ count: 0, to: null });
    expect(f.activity).toHaveLength(0);
    expect(result.cycle.carriedOverCount).toBe(0);
  });

  it("only an active cycle can be completed", async () => {
    const f = makeFake();
    const draft = f.addCycle();
    const done = f.addCycle({ status: "completed", projectId: "p2" });
    await expect(completeCycle(f.prisma, "u1", draft.id, { moveIncompleteTo: null })).rejects.toThrow("cycle_not_active");
    await expect(completeCycle(f.prisma, "u1", done.id, { moveIncompleteTo: null })).rejects.toThrow("cycle_not_active");
    await expect(completeCycle(f.prisma, "u1", "nope", { moveIncompleteTo: null })).rejects.toThrow("cycle_not_found");
  });

  describe("a bad target changes NOTHING (one transaction)", () => {
    it("the cycle itself", async () => {
      const { f, cycle, open1 } = scenario();
      await expect(completeCycle(f.prisma, "u1", cycle.id, { moveIncompleteTo: cycle.id })).rejects.toThrow("invalid_cycle");
      expect(f.cycles.find((c) => c.id === cycle.id)!.status).toBe("active");
      expect(cycleOf(f, open1.id)).toBe(cycle.id);
      expect(f.activity).toHaveLength(0);
    });

    it("a cycle in another project", async () => {
      const { f, cycle, open1 } = scenario();
      const foreign = f.addCycle({ projectId: "p2" });
      await expect(completeCycle(f.prisma, "u1", cycle.id, { moveIncompleteTo: foreign.id })).rejects.toThrow("invalid_cycle");
      expect(f.cycles.find((c) => c.id === cycle.id)!.status).toBe("active");
      expect(cycleOf(f, open1.id)).toBe(cycle.id);
    });

    it("a completed cycle", async () => {
      const { f, cycle, open1 } = scenario();
      const old = f.addCycle({ status: "completed" });
      await expect(completeCycle(f.prisma, "u1", cycle.id, { moveIncompleteTo: old.id })).rejects.toThrow("cycle_completed");
      expect(f.cycles.find((c) => c.id === cycle.id)!.status).toBe("active");
      expect(cycleOf(f, open1.id)).toBe(cycle.id);
    });

    it("a cycle that does not exist", async () => {
      const { f, cycle } = scenario();
      await expect(completeCycle(f.prisma, "u1", cycle.id, { moveIncompleteTo: "nope" })).rejects.toThrow("cycle_not_found");
      expect(f.cycles.find((c) => c.id === cycle.id)!.status).toBe("active");
    });
  });

  it("rolls the whole thing back when a write fails halfway", async () => {
    const { f, cycle, open1, open2 } = scenario();
    const act = (f.prisma as unknown as { pmActivity: { createMany: () => Promise<unknown> } }).pmActivity;
    act.createMany = async () => {
      throw new Error("disk full");
    };
    await expect(completeCycle(f.prisma, "u1", cycle.id, { moveIncompleteTo: null })).rejects.toThrow("disk full");
    expect(f.cycles.find((c) => c.id === cycle.id)!.status).toBe("active");
    expect(cycleOf(f, open1.id)).toBe(cycle.id);
    expect(cycleOf(f, open2.id)).toBe(cycle.id);
    expect(f.activity).toHaveLength(0);
  });

  it("runs at SERIALIZABLE — read the unfinished set, then move it — and says so", async () => {
    const { f, cycle } = scenario();
    await completeCycle(f.prisma, "u1", cycle.id, { moveIncompleteTo: null });
    expectAllTransactionsAt(f.seam, SERIALIZABLE_TX);
  });

  it("a serialization loser applied nothing and says concurrent_mutation", async () => {
    const { f, cycle } = scenario();
    f.seam.$transaction.mockImplementationOnce(async () => {
      throw prismaError("P2034");
    });
    await expect(completeCycle(f.prisma, "u1", cycle.id, { moveIncompleteTo: null })).rejects.toThrow("concurrent_mutation");
  });

  it("claims the cycle (the compare-and-set) BEFORE it reads which items are unfinished", async () => {
    const { f, cycle } = scenario();
    f.calls.length = 0;
    await completeCycle(f.prisma, "u1", cycle.id, { moveIncompleteTo: null });
    // The CAS is what makes an attach racing this either land first (and be
    // moved) or be refused — it has to be the first write, ahead of the read
    // that decides what moves.
    const firstCas = f.calls.indexOf("pmCycle.updateMany");
    const read = f.calls.indexOf("pmWorkItem.findMany");
    const move = f.calls.indexOf("pmWorkItem.updateMany");
    expect(firstCas).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(firstCas);
    expect(move).toBeGreaterThan(read);
  });
});

// ── delete ────────────────────────────────────────────────────────────────────

describe("deleteCycle", () => {
  it("audits every attached item BEFORE the database detaches them, then deletes", async () => {
    const f = makeFake();
    const c = f.addCycle({ status: "active" });
    const a = f.addItem({ cycleId: c.id });
    const b = f.addItem({ cycleId: c.id, isCompleted: true, stateId: "s-done" });
    const other = f.addItem({ cycleId: null });

    await deleteCycle(f.prisma, "u1", c.id);

    expect(f.cycles).toHaveLength(0);
    expect(a.cycleId).toBeNull();
    expect(b.cycleId).toBeNull();
    expect(other.cycleId).toBeNull();
    expect(f.activity.map((x) => x.workItemId).sort()).toEqual([a.id, b.id].sort());
    for (const row of f.activity) {
      expect(row).toMatchObject({ actorId: "u1", verb: "cycle_removed", field: "cycle", oldValue: c.id, newValue: null });
    }
    // audit first, delete last
    expect(f.calls.indexOf("pmActivity.createMany")).toBeLessThan(f.calls.indexOf("pmCycle.delete"));
  });

  it("an empty cycle deletes without writing any activity", async () => {
    const f = makeFake();
    const c = f.addCycle();
    await deleteCycle(f.prisma, "u1", c.id);
    expect(f.activity).toHaveLength(0);
  });

  it("cycle_not_found", async () => {
    const f = makeFake();
    await expect(deleteCycle(f.prisma, "u1", "nope")).rejects.toThrow("cycle_not_found");
  });
});

// ── reads ─────────────────────────────────────────────────────────────────────

describe("listCycles / getCycle", () => {
  it("returns progress per cycle from the items attached to it, archived ones excluded", async () => {
    const f = makeFake();
    const a = f.addCycle({ name: "A", status: "active" });
    f.addItem({ cycleId: a.id, stateId: "s-done", estimate: 5, isCompleted: true });
    f.addItem({ cycleId: a.id, stateId: "s-cancelled", estimate: 2, isCompleted: true });
    f.addItem({ cycleId: a.id, stateId: "s-doing", estimate: 3 });
    f.addItem({ cycleId: a.id, stateId: "s-doing", estimate: 100, isArchived: true });
    const b = f.addCycle({ name: "B" });

    const list = await listCycles(f.prisma, "p1");
    const byName = Object.fromEntries(list.map((c) => [c.name, c]));
    expect(byName.A.progress).toEqual({
      total: 3,
      completed: 1,
      cancelled: 1,
      totalEstimate: 10,
      completedEstimate: 5,
      cancelledEstimate: 2,
    });
    expect(byName.B.progress.total).toBe(0);
    expect((await getCycle(f.prisma, a.id)).progress.total).toBe(3);
    expect((await getCycle(f.prisma, b.id)).progress.total).toBe(0);
  });

  it("orders active first, then upcoming by start date, then completed newest first", async () => {
    const f = makeFake();
    f.addCycle({ name: "done-old", status: "completed", endDate: d("2026-08-01") });
    f.addCycle({ name: "later", startDate: d("2026-12-01"), endDate: d("2026-12-14") });
    f.addCycle({ name: "undated" , startDate: null, endDate: null });
    f.addCycle({ name: "done-new", status: "completed", endDate: d("2026-09-20") });
    f.addCycle({ name: "now", status: "active" });
    f.addCycle({ name: "soon", startDate: d("2026-11-02"), endDate: d("2026-11-13") });
    const names = (await listCycles(f.prisma, "p1")).map((c) => c.name);
    expect(names).toEqual(["now", "soon", "later", "undated", "done-new", "done-old"]);
  });

  it("project_not_found when listing an unknown project", async () => {
    const f = makeFake();
    await expect(listCycles(f.prisma, "nope")).rejects.toThrow("project_not_found");
  });

  it("cycle_not_found", async () => {
    const f = makeFake();
    await expect(getCycle(f.prisma, "nope")).rejects.toThrow("cycle_not_found");
  });
});

describe("listCycleWorkItems / listBacklog", () => {
  it("scopes the work-item list to the cycle, and reports the exact total", async () => {
    const f = makeFake();
    const c = f.addCycle();
    vi.mocked(pmService.listWorkItemsWhere).mockResolvedValue({ items: [], total: 42 });
    const out = await listCycleWorkItems(f.prisma, c.id, { perPage: 50, page: 2 });
    expect(out).toEqual({ work_items: [], total: 42 });
    expect(pmService.listWorkItemsWhere).toHaveBeenCalledWith(f.prisma, "p1", { cycleId: c.id }, { perPage: 50, page: 2 });
  });

  it("cycle_not_found", async () => {
    const f = makeFake();
    await expect(listCycleWorkItems(f.prisma, "nope", {})).rejects.toThrow("cycle_not_found");
  });

  it("the backlog is the project's UNFINISHED work that is in no cycle", async () => {
    const f = makeFake();
    vi.mocked(pmService.listWorkItemsWhere).mockResolvedValue({ items: [], total: 0 });
    await listBacklog(f.prisma, "p1", {});
    expect(pmService.listWorkItemsWhere).toHaveBeenCalledWith(
      f.prisma,
      "p1",
      { cycleId: null, isCompleted: false },
      {},
    );
  });
});

// ── burndown wiring ───────────────────────────────────────────────────────────

describe("getCycleBurndown", () => {
  const NOW = new Date("2026-10-08T10:00:00.000Z"); // Thursday of the cycle

  function at(iso: string, over: Partial<ActRow>): ActRow {
    return {
      workItemId: "x",
      actorId: "u1",
      verb: "cycle_added",
      field: "cycle",
      oldValue: null,
      newValue: null,
      createdAt: new Date(iso),
      ...over,
    };
  }

  it("rebuilds scope and remaining from the activity feed, including scope added mid-cycle", async () => {
    const f = makeFake();
    const cycle = f.addCycle({ status: "active", startDate: d("2026-10-05"), endDate: d("2026-10-09") });
    const a = f.addItem({ cycleId: cycle.id, stateId: "s-done", isCompleted: true, estimate: 5 });
    const b = f.addItem({ cycleId: cycle.id, stateId: "s-doing", estimate: 3 });
    const late = f.addItem({ cycleId: cycle.id, stateId: "s-todo", estimate: 2 });
    f.activity.push(
      at("2026-10-05T08:00:00Z", { workItemId: a.id, verb: "cycle_added", newValue: cycle.id }),
      at("2026-10-05T08:01:00Z", { workItemId: b.id, verb: "cycle_added", newValue: cycle.id }),
      // `late` joins on Wednesday
      at("2026-10-07T09:00:00Z", { workItemId: late.id, verb: "cycle_added", newValue: cycle.id }),
      // `a` is finished on Tuesday
      at("2026-10-06T15:00:00Z", {
        workItemId: a.id,
        verb: "state_changed",
        field: "state",
        oldValue: "s-doing",
        newValue: "s-done",
      }),
    );

    const out = await getCycleBurndown(f.prisma, cycle.id, { now: NOW });

    expect(out).toMatchObject({
      cycleId: cycle.id,
      status: "active",
      startDate: "2026-10-05",
      endDate: "2026-10-09",
      through: "2026-10-08",
      hasEstimates: true,
    });
    expect(out.days.map((p) => p.date)).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
    ]);
    expect(out.days.map((p) => p.scope)).toEqual([2, 2, 3, 3, null]);
    expect(out.days.map((p) => p.remaining)).toEqual([2, 1, 2, 2, null]);
    expect(out.days.map((p) => p.added)).toEqual([2, 0, 1, 0, null]);
    expect(out.days.map((p) => p.remainingEstimate)).toEqual([8, 3, 5, 5, null]);
  });

  it("only reads the activity that names THIS cycle, and only items that were ever in it", async () => {
    const f = makeFake();
    const cycle = f.addCycle({ status: "active", startDate: d("2026-10-05"), endDate: d("2026-10-07") });
    const other = f.addCycle({ name: "other", status: "completed", projectId: "p1" });
    const mine = f.addItem({ cycleId: cycle.id });
    const theirs = f.addItem({ cycleId: other.id });
    f.activity.push(
      at("2026-10-05T08:00:00Z", { workItemId: mine.id, newValue: cycle.id }),
      at("2026-10-05T08:00:00Z", { workItemId: theirs.id, newValue: other.id }),
    );
    const out = await getCycleBurndown(f.prisma, cycle.id, { now: NOW });
    expect(out.days[0].scope).toBe(1);
  });

  it("an item that LEFT the cycle (moved on) still shapes the past it was part of", async () => {
    const f = makeFake();
    const cycle = f.addCycle({ status: "active", startDate: d("2026-10-05"), endDate: d("2026-10-08") });
    const gone = f.addItem({ cycleId: null });
    f.activity.push(
      at("2026-10-05T08:00:00Z", { workItemId: gone.id, verb: "cycle_added", newValue: cycle.id }),
      at("2026-10-07T08:00:00Z", { workItemId: gone.id, verb: "cycle_removed", oldValue: cycle.id, newValue: null }),
    );
    const out = await getCycleBurndown(f.prisma, cycle.id, { now: NOW });
    expect(out.days.map((p) => p.scope)).toEqual([1, 1, 0, 0]);
    expect(out.days.map((p) => p.removed)).toEqual([0, 0, 1, 0]);
  });

  it("a move A → B is ONE row that reads as a leave for A and a join for B", async () => {
    const f = makeFake();
    const a = f.addCycle({ name: "A", status: "completed", startDate: d("2026-10-05"), endDate: d("2026-10-07"), completedAt: new Date("2026-10-07T18:00:00Z") });
    const b = f.addCycle({ name: "B", status: "active", startDate: d("2026-10-08"), endDate: d("2026-10-10") });
    const it = f.addItem({ cycleId: b.id });
    f.activity.push(
      at("2026-10-05T08:00:00Z", { workItemId: it.id, verb: "cycle_added", newValue: a.id }),
      at("2026-10-07T18:00:00Z", { workItemId: it.id, verb: "cycle_added", oldValue: a.id, newValue: b.id }),
    );
    const outA = await getCycleBurndown(f.prisma, a.id, { now: NOW });
    const outB = await getCycleBurndown(f.prisma, b.id, { now: NOW });
    expect(outA.days.map((p) => p.scope)).toEqual([1, 1, 0]); // left A at the end of Wed
    expect(outB.days[0].scope).toBe(1); // in B from Thursday
  });

  it("a completed cycle's chart stops the day it was completed, not on its planned end", async () => {
    const f = makeFake();
    const cycle = f.addCycle({
      status: "completed",
      startDate: d("2026-10-05"),
      endDate: d("2026-10-16"),
      completedAt: new Date("2026-10-07T17:00:00Z"),
    });
    f.addItem({ cycleId: cycle.id, isCompleted: true, stateId: "s-done" });
    const out = await getCycleBurndown(f.prisma, cycle.id, { now: new Date("2026-11-01T00:00:00Z") });
    expect(out.days.map((p) => p.date)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(out.through).toBe("2026-10-07");
  });

  it("a cycle with no dates has no chart, and says so rather than guessing", async () => {
    const f = makeFake();
    const cycle = f.addCycle({ startDate: null, endDate: null });
    const out = await getCycleBurndown(f.prisma, cycle.id, { now: NOW });
    expect(out).toMatchObject({ startDate: null, endDate: null, days: [], through: null, hasEstimates: false });
  });

  it("reads everything from ONE snapshot (REPEATABLE READ) — it composes one answer from several reads", async () => {
    const f = makeFake();
    const cycle = f.addCycle({ status: "active", startDate: d("2026-10-05"), endDate: d("2026-10-07") });
    await getCycleBurndown(f.prisma, cycle.id, { now: NOW });
    expectAllTransactionsAt(f.seam, REPEATABLE_READ_TX);
  });

  it("cycle_not_found", async () => {
    const f = makeFake();
    await expect(getCycleBurndown(f.prisma, "nope", { now: NOW })).rejects.toThrow("cycle_not_found");
  });

  it("hasEstimates is false when nothing in scope has one", async () => {
    const f = makeFake();
    const cycle = f.addCycle({ status: "active", startDate: d("2026-10-05"), endDate: d("2026-10-07") });
    f.addItem({ cycleId: cycle.id });
    expect((await getCycleBurndown(f.prisma, cycle.id, { now: NOW })).hasEstimates).toBe(false);
  });

  it("archived items are not part of the chart", async () => {
    const f = makeFake();
    const cycle = f.addCycle({ status: "active", startDate: d("2026-10-05"), endDate: d("2026-10-07") });
    f.addItem({ cycleId: cycle.id });
    f.addItem({ cycleId: cycle.id, isArchived: true });
    expect((await getCycleBurndown(f.prisma, cycle.id, { now: NOW })).days[0].scope).toBe(1);
  });
});
