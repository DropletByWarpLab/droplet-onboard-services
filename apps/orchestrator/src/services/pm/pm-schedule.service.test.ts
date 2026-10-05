/**
 * WARP-3523 — the Timeline window and My Work lists, DB-less.
 *
 * What a unit suite with a recording stub CAN prove: the shape of every query
 * (date windows are UTC-midnight, half-open on the far side), the query budget
 * (a fixed number of round trips regardless of how many items come back — the
 * "no N+1" rule), the caps and truncation flag, paging arithmetic, and that the
 * caller's id reaches the database only through the assignee / author filter.
 * What it cannot prove is that Postgres returns the right rows for those
 * predicates — `src/__tests__/pm-schedule.pg.test.ts` does that.
 */

import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  MY_WORK_DEFAULT_LIMIT,
  MY_WORK_MAX_LIMIT,
  TIMELINE_ITEM_LIMIT,
  TIMELINE_RELATION_LIMIT,
  addDaysUtc,
  diffDaysUtc,
  getMyWork,
  getProjectTimeline,
  isRealDateOnly,
  utcMidnight,
  utcToday,
} from "./pm-schedule.service.js";

// ── a recording stub ─────────────────────────────────────────────────────────

interface Row {
  [k: string]: unknown;
}

function workItemRow(over: Row = {}): Row {
  return {
    id: "w1",
    projectId: "p1",
    sequenceId: 1,
    name: "Item",
    descriptionHtml: null,
    stateId: "s1",
    state: { id: "s1", projectId: "p1", name: "Todo", group: "unstarted", color: null, sortOrder: 1, isDefault: true },
    priority: "none",
    parentId: null,
    cycleId: null,
    department: null,
    assignees: [{ userId: "u1" }],
    labels: [],
    startDate: null,
    dueDate: new Date("2026-10-05T00:00:00.000Z"),
    sortOrder: 0,
    completedAt: null,
    createdById: null,
    _count: { comments: 0, children: 0 },
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    project: { id: "p1", name: "Onboarding", identifier: "INBOX", icon: null, color: "#6366f1", department: null },
    ...over,
  };
}

function makeStub(opts: { project?: Row | null; items?: Row[]; edges?: Row[]; modules?: Row[]; counts?: number[] } = {}) {
  const counts = [...(opts.counts ?? [0, 0, 0, 0])];
  const prisma = {
    pmProject: {
      findUnique: vi.fn(async () =>
        opts.project === undefined ? { id: "p1", identifier: "INBOX", department: null } : opts.project,
      ),
    },
    pmWorkItem: {
      findMany: vi.fn(async () => opts.items ?? []),
      count: vi.fn(async () => counts.shift() ?? 0),
    },
    pmWorkItemRelation: { findMany: vi.fn(async () => opts.edges ?? []) },
    pmModule: { findMany: vi.fn(async () => opts.modules ?? []) },
  };
  return { prisma, db: prisma as unknown as PrismaClient };
}

// ── date-only helpers ────────────────────────────────────────────────────────

describe("date-only helpers (UTC, never local time)", () => {
  it("isRealDateOnly rejects what is not a calendar date", () => {
    expect(isRealDateOnly("2026-10-03")).toBe(true);
    expect(isRealDateOnly("2028-02-29")).toBe(true);
    expect(isRealDateOnly("2026-02-30")).toBe(false);
    expect(isRealDateOnly("2027-02-29")).toBe(false);
    expect(isRealDateOnly("2026-13-01")).toBe(false);
    expect(isRealDateOnly("2026-00-01")).toBe(false);
    expect(isRealDateOnly("2026-10-00")).toBe(false);
    expect(isRealDateOnly("2026-10-03T00:00:00Z")).toBe(false);
    expect(isRealDateOnly("tomorrow")).toBe(false);
  });

  it("bounds the year to 1900-2200: past 9999 a date cannot be converted, and 0002 is a typo", () => {
    expect(isRealDateOnly("1900-01-01")).toBe(true);
    expect(isRealDateOnly("2200-12-31")).toBe(true);
    expect(isRealDateOnly("1899-12-31")).toBe(false);
    expect(isRealDateOnly("2201-01-01")).toBe(false);
    expect(isRealDateOnly("0002-10-20")).toBe(false);
    expect(isRealDateOnly("9999-12-31")).toBe(false);
  });

  it("utcMidnight is exactly the stored 00:00:00Z", () => {
    expect(utcMidnight("2026-10-03").toISOString()).toBe("2026-10-03T00:00:00.000Z");
  });

  it("addDaysUtc crosses month and leap-year boundaries", () => {
    expect(addDaysUtc("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDaysUtc("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysUtc("2027-02-28", 1)).toBe("2027-03-01");
    expect(addDaysUtc("2026-12-31", 7)).toBe("2027-01-07");
    expect(addDaysUtc("2026-01-03", -5)).toBe("2025-12-29");
  });

  it("diffDaysUtc counts whole days regardless of DST in the server's zone", () => {
    expect(diffDaysUtc("2026-10-31", "2026-11-02")).toBe(2);
    expect(diffDaysUtc("2026-03-07", "2026-03-09")).toBe(2);
    expect(diffDaysUtc("2026-01-01", "2027-01-01")).toBe(365);
  });

  it("utcToday is the UTC date of the instant", () => {
    expect(utcToday(new Date("2026-10-03T23:59:59.000Z"))).toBe("2026-10-03");
    expect(utcToday(new Date("2026-10-04T00:00:00.000Z"))).toBe("2026-10-04");
  });
});

// ── timeline ─────────────────────────────────────────────────────────────────

describe("getProjectTimeline", () => {
  const range = { from: "2026-10-01", to: "2026-10-31" };

  it("throws project_not_found for an unknown project, before any item query", async () => {
    const { prisma, db } = makeStub({ project: null });
    await expect(getProjectTimeline(db, "nope", range)).rejects.toThrow("project_not_found");
    expect(prisma.pmWorkItem.findMany).not.toHaveBeenCalled();
  });

  it("answers for a service desk exactly as for an unknown project, before reading its schedule", async () => {
    const { prisma, db } = makeStub({ project: { id: "desk", kind: "SERVICE_DESK", identifier: "SUP", department: null } });
    await expect(getProjectTimeline(db, "desk", range)).rejects.toThrow("project_not_found");
    expect(prisma.pmWorkItem.findMany).not.toHaveBeenCalled();
    expect(prisma.pmWorkItem.count).not.toHaveBeenCalled();
    expect(prisma.pmModule.findMany).not.toHaveBeenCalled();
    expect(prisma.pmWorkItemRelation.findMany).not.toHaveBeenCalled();
  });

  it("windows by UTC calendar day: from at midnight, to as an exclusive midnight after the last day", async () => {
    const { prisma, db } = makeStub();
    await getProjectTimeline(db, "p1", range);
    const where = (prisma.pmWorkItem.findMany.mock.calls[0] as unknown as [{ where: Row }])[0].where as {
      projectId: string;
      isArchived: boolean;
      OR: Array<Record<string, unknown>>;
    };
    const fromAt = new Date("2026-10-01T00:00:00.000Z");
    const endBefore = new Date("2026-11-01T00:00:00.000Z");
    expect(where.projectId).toBe("p1");
    expect(where.isArchived).toBe(false);
    expect(where.OR).toEqual([
      { startDate: { lt: endBefore }, dueDate: { gte: fromAt } },
      { dueDate: { lt: endBefore }, startDate: { gte: fromAt } },
      { startDate: null, dueDate: { gte: fromAt, lt: endBefore } },
      { dueDate: null, startDate: { gte: fromAt, lt: endBefore } },
    ]);
    const modulesWhere = (prisma.pmModule.findMany.mock.calls[0] as unknown as [{ where: Row }])[0].where;
    expect(modulesWhere).toEqual({ projectId: "p1", targetDate: { gte: fromAt, lt: endBefore } });
  });

  it("asks for one row past the cap so truncation is detected, in the board's stable order", async () => {
    const { prisma, db } = makeStub();
    await getProjectTimeline(db, "p1", range);
    const args = (prisma.pmWorkItem.findMany.mock.calls[0] as unknown as [Row])[0];
    expect(args.take).toBe(TIMELINE_ITEM_LIMIT + 1);
    expect(args.orderBy).toEqual([{ sortOrder: "asc" }, { sequenceId: "asc" }]);
  });

  it("spends a FIXED number of queries however many items match (no N+1)", async () => {
    const items = Array.from({ length: 40 }, (_, i) => workItemRow({ id: `w${i}`, sequenceId: i + 1 }));
    const { prisma, db } = makeStub({ items });
    await getProjectTimeline(db, "p1", range);
    expect(prisma.pmProject.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.pmWorkItem.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.pmWorkItemRelation.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.pmModule.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.pmWorkItem.count).toHaveBeenCalledTimes(1);
  });

  it("does not query relations at all when no item is in the window", async () => {
    const { prisma, db } = makeStub({ items: [] });
    const res = await getProjectTimeline(db, "p1", range);
    expect(prisma.pmWorkItemRelation.findMany).not.toHaveBeenCalled();
    expect(res.relations).toEqual([]);
    expect(res.items).toEqual([]);
  });

  it("fetches only BLOCKS edges whose BOTH ends are in the returned items", async () => {
    const { prisma, db } = makeStub({
      items: [workItemRow({ id: "a" }), workItemRow({ id: "b", sequenceId: 2 })],
      edges: [{ id: "e1", fromId: "a", toId: "b" }],
    });
    const res = await getProjectTimeline(db, "p1", range);
    const args = (prisma.pmWorkItemRelation.findMany.mock.calls[0] as unknown as [{ where: Row; take: number }])[0];
    expect(args.where).toEqual({ kind: "BLOCKS", fromId: { in: ["a", "b"] }, toId: { in: ["a", "b"] } });
    expect(args.take).toBe(TIMELINE_RELATION_LIMIT + 1);
    expect(res.relations).toEqual([{ id: "e1", kind: "BLOCKS", fromId: "a", toId: "b" }]);
  });

  it("maps items exactly like the board: key, ISO dates, department inheritance", async () => {
    const dept = { id: "d1", name: "Front Desk", kind: "DEPARTMENT", parentId: null };
    const { db } = makeStub({
      project: { id: "p1", identifier: "INBOX", department: dept },
      items: [workItemRow({ startDate: new Date("2026-10-03T00:00:00.000Z") })],
    });
    const res = await getProjectTimeline(db, "p1", range);
    expect(res.items[0]).toMatchObject({
      key: "INBOX-1",
      startDate: "2026-10-03T00:00:00.000Z",
      dueDate: "2026-10-05T00:00:00.000Z",
      department: { id: "d1", name: "Front Desk", source: "project" },
    });
  });

  it("echoes the window and reports milestones as plain calendar dates", async () => {
    const { db } = makeStub({
      modules: [{ id: "m1", name: "Beta", status: "in_progress", targetDate: new Date("2026-10-30T00:00:00.000Z") }],
      counts: [12],
    });
    const res = await getProjectTimeline(db, "p1", range);
    expect(res).toMatchObject({ from: "2026-10-01", to: "2026-10-31", unscheduledCount: 12, truncated: false });
    expect(res.milestones).toEqual([{ id: "m1", name: "Beta", status: "in_progress", targetDate: "2026-10-30" }]);
  });

  it("counts unscheduled as non-archived items with neither date", async () => {
    const { prisma, db } = makeStub();
    await getProjectTimeline(db, "p1", range);
    expect((prisma.pmWorkItem.count.mock.calls[0] as unknown as [{ where: Row }])[0].where).toEqual({
      projectId: "p1",
      isArchived: false,
      startDate: null,
      dueDate: null,
    });
  });

  it("flags truncation and returns exactly the cap when more items matched", async () => {
    const items = [workItemRow({ id: "a" }), workItemRow({ id: "b", sequenceId: 2 }), workItemRow({ id: "c", sequenceId: 3 })];
    const { db } = makeStub({ items });
    const res = await getProjectTimeline(db, "p1", range, { itemLimit: 2 });
    expect(res.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(res.truncated).toBe(true);
  });

  it("flags truncation when only the relation cap was hit", async () => {
    const { db } = makeStub({
      items: [workItemRow({ id: "a" }), workItemRow({ id: "b", sequenceId: 2 })],
      edges: [
        { id: "e1", fromId: "a", toId: "b" },
        { id: "e2", fromId: "b", toId: "a" },
      ],
    });
    const res = await getProjectTimeline(db, "p1", range, { relationLimit: 1 });
    expect(res.relations).toHaveLength(1);
    expect(res.truncated).toBe(true);
  });

  it("is not truncated at exactly the cap", async () => {
    const { db } = makeStub({ items: [workItemRow({ id: "a" }), workItemRow({ id: "b", sequenceId: 2 })] });
    const res = await getProjectTimeline(db, "p1", range, { itemLimit: 2 });
    expect(res.items).toHaveLength(2);
    expect(res.truncated).toBe(false);
  });
});

// ── my work ──────────────────────────────────────────────────────────────────

type Where = { AND: Array<Record<string, unknown>> };

describe("getMyWork", () => {
  const today = "2026-10-03";

  function listArgs(prisma: ReturnType<typeof makeStub>["prisma"]) {
    return (prisma.pmWorkItem.findMany.mock.calls[0] as unknown as [{ where: Where; orderBy: unknown[]; skip: number; take: number; include: Row }])[0];
  }
  function countWheres(prisma: ReturnType<typeof makeStub>["prisma"]): Where[] {
    return (prisma.pmWorkItem.count.mock.calls as unknown as Array<[{ where: Where }]>).map((c) => c[0].where);
  }

  it("every section and count is limited to live items of live PROJECT containers that are still open", async () => {
    for (const section of ["assigned", "created", "overdue", "due_this_week"] as const) {
      const { prisma, db } = makeStub();
      await getMyWork(db, "u1", { section, today });
      const [base, open] = listArgs(prisma).where.AND;
      expect(base).toEqual({ isArchived: false, project: { isArchived: false, kind: "PROJECT" } });
      expect(open).toEqual({ OR: [{ stateId: null }, { state: { group: { in: ["backlog", "unstarted", "started"] } } }] });
      for (const where of countWheres(prisma)) {
        expect(where.AND[0]).toEqual(base);
      }
    }
  });

  it("assigned = the caller is an assignee; created = the caller wrote it", async () => {
    const a = makeStub();
    await getMyWork(a.db, "u1", { section: "assigned", today });
    expect(listArgs(a.prisma).where.AND).toContainEqual({ assignees: { some: { userId: "u1" } } });
    const c = makeStub();
    await getMyWork(c.db, "u1", { section: "created", today });
    expect(listArgs(c.prisma).where.AND).toContainEqual({ createdById: "u1" });
    expect(JSON.stringify(listArgs(c.prisma).where)).not.toContain("assignees");
  });

  it("overdue = assigned and due strictly before the viewer's today (due today is NOT overdue)", async () => {
    const { prisma, db } = makeStub();
    await getMyWork(db, "u1", { section: "overdue", today });
    const clauses = listArgs(prisma).where.AND;
    expect(clauses).toContainEqual({ assignees: { some: { userId: "u1" } } });
    expect(clauses).toContainEqual({ dueDate: { lt: new Date("2026-10-03T00:00:00.000Z") } });
  });

  it("due_this_week = today through today + 6, as [today, today + 7)", async () => {
    const { prisma, db } = makeStub();
    await getMyWork(db, "u1", { section: "due_this_week", today });
    expect(listArgs(prisma).where.AND).toContainEqual({
      dueDate: { gte: new Date("2026-10-03T00:00:00.000Z"), lt: new Date("2026-10-10T00:00:00.000Z") },
    });
  });

  it("the window follows the viewer's today, across a month boundary", async () => {
    const { prisma, db } = makeStub();
    await getMyWork(db, "u1", { section: "due_this_week", today: "2026-10-28" });
    expect(listArgs(prisma).where.AND).toContainEqual({
      dueDate: { gte: new Date("2026-10-28T00:00:00.000Z"), lt: new Date("2026-11-04T00:00:00.000Z") },
    });
  });

  it("spends one list query and four counts, never one per item", async () => {
    const items = Array.from({ length: 60 }, (_, i) => workItemRow({ id: `w${i}`, sequenceId: i + 1 }));
    const { prisma, db } = makeStub({ items, counts: [60, 4, 2, 7] });
    await getMyWork(db, "u1", { section: "assigned", today });
    expect(prisma.pmWorkItem.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.pmWorkItem.count).toHaveBeenCalledTimes(4);
    expect(prisma.pmProject.findUnique).not.toHaveBeenCalled();
    expect(prisma.pmWorkItemRelation.findMany).not.toHaveBeenCalled();
  });

  it("each count uses the SAME predicate as the list of that section", async () => {
    const { prisma, db } = makeStub();
    await getMyWork(db, "u1", { section: "overdue", today });
    const wheres = countWheres(prisma);
    expect(wheres).toHaveLength(4);
    expect(wheres[2]).toEqual(listArgs(prisma).where);
  });

  it("reports all four counts and the requested section's total", async () => {
    // counts resolve in call order: assigned, created, overdue, due_this_week
    const { db } = makeStub({ items: [workItemRow()], counts: [12, 4, 3, 5] });
    const res = await getMyWork(db, "u1", { section: "due_this_week", today });
    expect(res.counts).toEqual({ assigned: 12, created: 4, overdue: 3, dueThisWeek: 5 });
    expect(res.total).toBe(5);
    expect(res).toMatchObject({ section: "due_this_week", today });
  });

  it("orders projects together, then by the section's own rule, with id as the final tiebreak", async () => {
    const a = makeStub();
    await getMyWork(a.db, "u1", { section: "assigned", today });
    expect(listArgs(a.prisma).orderBy).toEqual([
      { project: { sortOrder: "asc" } },
      { project: { createdAt: "asc" } },
      { projectId: "asc" },
      { priority: "asc" },
      { dueDate: { sort: "asc", nulls: "last" } },
      { sequenceId: "asc" },
      { id: "asc" },
    ]);
    const o = makeStub();
    await getMyWork(o.db, "u1", { section: "overdue", today });
    expect(listArgs(o.prisma).orderBy).toEqual([
      { project: { sortOrder: "asc" } },
      { project: { createdAt: "asc" } },
      { projectId: "asc" },
      { dueDate: "asc" },
      { priority: "asc" },
      { sequenceId: "asc" },
      { id: "asc" },
    ]);
  });

  it("joins the project once per row and lists each project once, in first-appearance order", async () => {
    const pA = { id: "pa", name: "Alpha", identifier: "AAA", icon: "rocket", color: "#111111", department: null };
    const pB = { id: "pb", name: "Bravo", identifier: "BBB", icon: null, color: null, department: null };
    const items = [
      workItemRow({ id: "1", projectId: "pa", sequenceId: 1, project: pA }),
      workItemRow({ id: "2", projectId: "pa", sequenceId: 2, project: pA }),
      workItemRow({ id: "3", projectId: "pb", sequenceId: 1, project: pB }),
    ];
    const { prisma, db } = makeStub({ items, counts: [3, 0, 0, 0] });
    const res = await getMyWork(db, "u1", { section: "assigned", today });
    expect(res.projects).toEqual([
      { id: "pa", name: "Alpha", identifier: "AAA", icon: "rocket", color: "#111111" },
      { id: "pb", name: "Bravo", identifier: "BBB", icon: null, color: null },
    ]);
    expect(res.items.map((i) => i.key)).toEqual(["AAA-1", "AAA-2", "BBB-1"]);
    const include = listArgs(prisma).include as { project: { select: Row } };
    expect(include.project.select).toMatchObject({ id: true, name: true, identifier: true, icon: true, color: true });
  });

  it("defaults and clamps the page size and offset", async () => {
    const d = makeStub();
    const def = await getMyWork(d.db, "u1", { section: "assigned", today });
    expect(def.limit).toBe(MY_WORK_DEFAULT_LIMIT);
    expect(listArgs(d.prisma)).toMatchObject({ skip: 0, take: MY_WORK_DEFAULT_LIMIT });

    const big = makeStub();
    expect((await getMyWork(big.db, "u1", { section: "assigned", today, limit: 9999 })).limit).toBe(MY_WORK_MAX_LIMIT);
    const small = makeStub();
    expect((await getMyWork(small.db, "u1", { section: "assigned", today, limit: 0, offset: -5 })).limit).toBe(1);
    expect(listArgs(small.prisma).skip).toBe(0);
  });

  it("nextOffset walks the pages and ends at null", async () => {
    const two = [workItemRow({ id: "a" }), workItemRow({ id: "b", sequenceId: 2 })];
    const first = await getMyWork(makeStub({ items: two, counts: [5, 0, 0, 0] }).db, "u1", { section: "assigned", today, limit: 2, offset: 0 });
    expect(first.nextOffset).toBe(2);
    const last = await getMyWork(makeStub({ items: [workItemRow({ id: "e", sequenceId: 5 })], counts: [5, 0, 0, 0] }).db, "u1", {
      section: "assigned",
      today,
      limit: 2,
      offset: 4,
    });
    expect(last.nextOffset).toBeNull();
    expect(last.offset).toBe(4);
  });

  it("an empty page never advertises another one, even when the count is stale", async () => {
    const res = await getMyWork(makeStub({ items: [], counts: [5, 0, 0, 0] }).db, "u1", { section: "assigned", today, offset: 2 });
    expect(res.nextOffset).toBeNull();
  });
});
