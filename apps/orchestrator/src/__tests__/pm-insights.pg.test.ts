/**
 * WARP-3524 (WS-8) — the Insights numbers, proved against a real Postgres.
 *
 * Every figure `GET /api/pm/insights` returns is an aggregate computed in SQL
 * over rows PM already writes, with history rebuilt from `PmActivity`. None of
 * that is provable against a mocked Prisma: the SQL IS the implementation. So
 * this suite builds a fixture of items with KNOWN transitions at fixed
 * instants, and asserts the numbers a person could work out on paper, plus a
 * second, independent computation of the cumulative flow (plain loops over the
 * fixture) compared with what the SQL returned for every day.
 *
 * The fixture is chosen to hit the awkward cases on purpose: an item that
 * skipped `started`, one born in progress, one re-opened after finishing, a
 * cancelled one, an archived one, a stateless one, one parked in a state that
 * has since been deleted, an archived project, and a second project for the
 * workspace view. "Now" is pinned (2026-10-04, a Sunday, 12:00Z) and so is the
 * zone; the zone tests pass their own.
 *
 * Gated like every other `*.pg.test.ts`: RUN_PG_INTEGRATION=1 + DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  clearInsightsCache,
  getInsights,
  INSIGHTS_CACHE_TTL_MS,
  INSIGHTS_ERRORS,
} from "../services/pm/pm-insights.service.js";
import { getSummary, PM_ERRORS } from "../services/pm/pm.service.js";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

type Group = "backlog" | "unstarted" | "started" | "completed" | "cancelled";
type Band = Group | "unknown";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const RANGE = { from: "2026-09-07", to: "2026-10-04", groupBy: "week" as const };

/** `at("09-08")` → 2026-09-08 10:00Z; `at("09-08", "08:00")` → 08:00Z. */
const at = (md: string, hm = "10:00") => new Date(`2026-${md}T${hm}:00.000Z`);

/** A state NAME, `null` (an item with no state), or a state that no longer exists. */
type Step = string | null;
const DELETED = "<deleted>";

interface ItemDef {
  seq: number;
  /** Where the item was created, then each move, in time order. */
  path: Array<[Date, Step]>;
  /** The state it is in NOW, when that is not where the path ends (a silent re-park). */
  current?: Step;
  completedAt?: Date;
  archived?: boolean;
  assignees?: string[];
  dueDate?: Date;
}

const P1_STATES: Array<[string, Group, boolean?]> = [
  ["Backlog", "backlog"],
  ["Todo", "unstarted", true],
  ["Doing", "started"],
  ["Review", "started"],
  ["Done", "completed"],
  ["Dropped", "cancelled"],
];
const P2_STATES: Array<[string, Group, boolean?]> = [
  ["Todo", "unstarted", true],
  ["Doing", "started"],
  ["Done", "completed"],
  ["Dropped", "cancelled"],
];

const A = "w8-user-a";
const B = "w8-user-b";
const C = "w8-user-c";

const P1_ITEMS: ItemDef[] = [
  // Finished in the range: created before it, started 09-08, done 09-10. Lead 9d, cycle 2d.
  { seq: 1, path: [[at("09-01"), "Todo"], [at("09-08"), "Doing"], [at("09-10"), "Done"]], completedAt: at("09-10"), assignees: [A], dueDate: at("09-01") },
  // Todo → Doing → Review → Done. The Review move is started → started. Lead 9d, cycle 8d.
  { seq: 2, path: [[at("09-08", "08:00"), "Todo"], [at("09-09", "08:00"), "Doing"], [at("09-16", "08:00"), "Review"], [at("09-17", "08:00"), "Done"]], completedAt: at("09-17", "08:00") },
  // Skipped `started`: lead 2d, no cycle time.
  { seq: 3, path: [[at("09-15"), "Backlog"], [at("09-16"), "Todo"], [at("09-17"), "Done"]], completedAt: at("09-17") },
  // Born in progress (no move into started to find): lead 3d, cycle 3d.
  { seq: 4, path: [[at("09-22"), "Doing"], [at("09-25"), "Done"]], completedAt: at("09-25") },
  // In progress since 09-30, overdue.
  { seq: 5, path: [[at("09-29"), "Todo"], [at("09-30"), "Doing"]], assignees: [A], dueDate: at("10-03") },
  // Waiting in the backlog with two owners.
  { seq: 6, path: [[at("09-10"), "Backlog"]], assignees: [A, B], dueDate: at("10-10") },
  // Finished 09-14, then RE-OPENED 09-20: not finished work any more.
  { seq: 7, path: [[at("09-12"), "Todo"], [at("09-13"), "Doing"], [at("09-14"), "Done"], [at("09-20"), "Doing"]], assignees: [B] },
  // Cancelled: its own band, never throughput.
  { seq: 8, path: [[at("09-16"), "Todo"], [at("09-18"), "Dropped"]], completedAt: at("09-18") },
  // Archived: nowhere.
  { seq: 9, path: [[at("09-10"), "Todo"], [at("09-12"), "Done"]], completedAt: at("09-12"), archived: true },
  // Moved into a state that was then deleted, and silently re-parked in Todo.
  { seq: 10, path: [[at("09-16"), "Todo"], [at("09-17"), DELETED]], current: "Todo" },
  // No state at all: counts as unstarted.
  { seq: 11, path: [[at("09-20"), null]] },
  // Finished before the range: part of the starting picture, not of the range's numbers.
  { seq: 12, path: [[at("08-20"), "Todo"], [at("08-25"), "Doing"], [at("08-28"), "Done"]], completedAt: at("08-28") },
];

const P2_ITEMS: ItemDef[] = [
  { seq: 1, path: [[at("09-29"), "Todo"], [at("09-30"), "Doing"], [at("10-02"), "Done"]], completedAt: at("10-02"), assignees: [C] },
  { seq: 2, path: [[at("10-01"), "Todo"]], dueDate: at("10-01") },
  { seq: 3, path: [[at("10-01"), "Todo"], [at("10-03"), "Dropped"]], completedAt: at("10-03") },
];

describe.skipIf(!RUN)("PM insights (WARP-3524)", () => {
  let prisma: PrismaClient;
  let slug: string;
  let p1: string;
  let p2: string;
  const defs = new Map<string, { items: ItemDef[]; groups: Map<string, Group> }>();

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>(
      "@prisma/client",
    );
    prisma = new RealPrismaClient();
    await prisma.$connect();
    await prisma.pmWorkspace.deleteMany({ where: { slug: { startsWith: "ws8-" } } });
    slug = `ws8-${Date.now().toString(36)}`;
    const ws = await prisma.pmWorkspace.create({ data: { slug, name: "WS8" } });

    p1 = await buildProject(ws.id, "WSA", "WS8 Alpha", P1_STATES, P1_ITEMS, false);
    p2 = await buildProject(ws.id, "WSB", "WS8 Beta", P2_STATES, P2_ITEMS, false);
    // An archived project: out of the workspace view and out of the summary.
    await buildProject(
      ws.id,
      "WSC",
      "WS8 Gamma",
      P2_STATES,
      [{ seq: 1, path: [[at("09-20"), "Todo"]] }],
      true,
    );
  });

  afterAll(async () => {
    await prisma.pmWorkspace.deleteMany({ where: { slug: { startsWith: "ws8-" } } });
    await prisma.$disconnect();
  });

  beforeEach(() => {
    clearInsightsCache();
  });

  /** A workspace of its own, so a test that adds projects cannot change the shared fixture's numbers. */
  async function scratchWorkspace(): Promise<string> {
    const ws = await prisma.pmWorkspace.create({
      data: { slug: `ws8-x-${Math.random().toString(36).slice(2, 9)}`, name: "WS8 scratch" },
    });
    return ws.id;
  }

  /**
   * Writes a project, its states, items, assignees and activity. Returns the project id.
   * Activity rows are `not_needed`: they are fixtures, not events, and the pg suites
   * share one database with the notification sweep (activity-notify.pg.test.ts).
   */
  async function buildProject(
    workspaceId: string,
    identifier: string,
    name: string,
    stateDefs: Array<[string, Group, boolean?]>,
    items: ItemDef[],
    archived: boolean,
  ): Promise<string> {
    const project = await prisma.pmProject.create({
      data: { workspaceId, identifier, name, isArchived: archived },
    });
    const stateIds = new Map<string, string>();
    const groups = new Map<string, Group>();
    let order = 0;
    for (const [stateName, group, isDefault] of stateDefs) {
      const s = await prisma.pmState.create({
        data: { projectId: project.id, name: stateName, group, isDefault: isDefault === true, sortOrder: order++ },
      });
      stateIds.set(stateName, s.id);
      groups.set(stateName, group);
    }
    // A state id that resolves to nothing: the shape a deleted state leaves in old activity rows.
    const deletedId = `deleted-state-${project.id}`;
    const idOf = (step: Step): string | null =>
      step === null ? null : step === DELETED ? deletedId : (stateIds.get(step) as string);

    for (const it of items) {
      const last = it.path[it.path.length - 1][1];
      const cur = it.current !== undefined ? it.current : last;
      const curGroup = cur === null ? null : groups.get(cur);
      const row = await prisma.pmWorkItem.create({
        data: {
          projectId: project.id,
          sequenceId: it.seq,
          name: `${identifier}-${it.seq}`,
          stateId: idOf(cur),
          createdAt: it.path[0][0],
          isCompleted: curGroup === "completed" || curGroup === "cancelled",
          completedAt: it.completedAt ?? null,
          isArchived: it.archived === true,
          dueDate: it.dueDate ?? null,
          assignees: it.assignees?.length ? { create: it.assignees.map((userId) => ({ userId })) } : undefined,
        },
      });
      await prisma.pmActivity.create({
        data: { workItemId: row.id, verb: "created", createdAt: it.path[0][0], notifyStatus: "not_needed" },
      });
      for (let i = 1; i < it.path.length; i++) {
        await prisma.pmActivity.create({
          data: {
            workItemId: row.id,
            verb: "state_changed",
            field: "state",
            oldValue: idOf(it.path[i - 1][1]),
            newValue: idOf(it.path[i][1]),
            createdAt: it.path[i][0],
            notifyStatus: "not_needed",
          },
        });
      }
    }
    defs.set(project.id, { items, groups });
    return project.id;
  }

  /** The cumulative flow worked out with plain loops over the fixture, no SQL. */
  function referenceCfd(projectIds: string[], from: string, to: string): Array<{ date: string } & Record<Band, number>> {
    const out: Array<{ date: string } & Record<Band, number>> = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
      const date = new Date(t).toISOString().slice(0, 10);
      const dayEnd = t + 86_400_000;
      const day = { date, backlog: 0, unstarted: 0, started: 0, completed: 0, cancelled: 0, unknown: 0 };
      for (const pid of projectIds) {
        const { items, groups } = defs.get(pid)!;
        for (const it of items) {
          if (it.archived || it.path[0][0].getTime() >= dayEnd) continue;
          let step: Step = it.path[0][1];
          for (const [when, to2] of it.path) if (when.getTime() < dayEnd) step = to2;
          // The live row is a closing snapshot for today only. A historical
          // range ending mid-history must retain the state reconstructed from
          // its activity rows at that point in time.
          const today = NOW.toISOString().slice(0, 10);
          const finalStep = date === today && it.current !== undefined ? it.current : step;
          const band: Band = finalStep === null ? "unstarted" : finalStep === DELETED ? "unknown" : (groups.get(finalStep) as Group);
          day[band] += 1;
        }
      }
      out.push(day);
    }
    return out;
  }

  describe("throughput, created vs completed, durations (project)", () => {
    it("counts finished work per week, leaving out cancelled, re-opened and archived items", async () => {
      const r = await getInsights(prisma, { projectId: p1, ...RANGE }, { now: NOW, timezone: "UTC" });
      expect(r.meta).toMatchObject({
        scope: "project",
        projectId: p1,
        from: "2026-09-07",
        to: "2026-10-04",
        groupBy: "week",
        timezone: "UTC",
        itemCount: 11, // 12 items minus the archived one
      });
      expect(r.throughput.buckets).toEqual([
        { start: "2026-09-07", completed: 1 }, // item 1; item 7 finished 09-14 but was re-opened
        { start: "2026-09-14", completed: 2 }, // items 2 and 3
        { start: "2026-09-21", completed: 1 }, // item 4
        { start: "2026-09-28", completed: 0 }, // item 8 was cancelled, not finished
      ]);
      expect(r.throughput.total).toBe(4);
    });

    it("counts created work per week against finished work", async () => {
      const r = await getInsights(prisma, { projectId: p1, ...RANGE }, { now: NOW, timezone: "UTC" });
      expect(r.createdVsCompleted.buckets).toEqual([
        { start: "2026-09-07", created: 3, completed: 1 }, // items 2, 6, 7
        { start: "2026-09-14", created: 4, completed: 2 }, // items 3, 8, 10, 11 (09-20 is a Sunday)
        { start: "2026-09-21", created: 1, completed: 1 }, // item 4
        { start: "2026-09-28", created: 1, completed: 0 }, // item 5
      ]);
      expect(r.createdVsCompleted.created).toBe(9);
      expect(r.createdVsCompleted.completed).toBe(4);
    });

    it("measures lead time from creation and cycle time from the first start", async () => {
      const r = await getInsights(prisma, { projectId: p1, ...RANGE }, { now: NOW, timezone: "UTC" });
      // Lead: 9, 9, 2, 3 days.
      expect(r.leadTime).toMatchObject({ count: 4, p50: 6, p85: 9, p95: 9 });
      expect(r.leadTime.edgesDays).toEqual([1, 2, 4, 7, 14, 30]);
      expect(r.leadTime.counts).toEqual([0, 0, 2, 0, 2, 0, 0]); // 2-4d: items 3, 4; 7-14d: items 1, 2
      // Cycle: 2, 8, 3 days. Item 3 skipped `started`, so it has none; item 4 was born started.
      expect(r.cycleTime).toMatchObject({ count: 3, p50: 3, p85: 6.5, p95: 7.5 });
      expect(r.cycleTime.counts).toEqual([0, 0, 2, 0, 1, 0, 0]);
    });

    it("reports nothing measured, not zeros, when nothing finished in the range", async () => {
      const r = await getInsights(
        prisma,
        { projectId: p1, from: "2026-08-01", to: "2026-08-14", groupBy: "week" },
        { now: NOW, timezone: "UTC" },
      );
      expect(r.leadTime).toMatchObject({ count: 0, p50: null, p85: null, p95: null });
      expect(r.cycleTime.count).toBe(0);
      expect(r.cycleTime.counts).toEqual([0, 0, 0, 0, 0, 0, 0]);
    });
  });

  describe("cumulative flow", () => {
    it("puts every item in exactly one band every day, matching an independent walk of the fixture", async () => {
      const r = await getInsights(prisma, { projectId: p1, ...RANGE }, { now: NOW, timezone: "UTC" });
      const expected = referenceCfd([p1], "2026-09-07", "2026-10-04");
      expect(r.cumulativeFlow.days).toEqual(expected);
      expect(r.cumulativeFlow.days).toHaveLength(28);
    });

    it("matches the picture worked out by hand on three days", async () => {
      const r = await getInsights(prisma, { projectId: p1, ...RANGE }, { now: NOW, timezone: "UTC" });
      const day = (d: string) => r.cumulativeFlow.days.find((x) => x.date === d)!;
      // 09-07: item 1 still in Todo, item 12 already done.
      expect(day("2026-09-07")).toEqual({ date: "2026-09-07", backlog: 0, unstarted: 1, started: 0, completed: 1, cancelled: 0, unknown: 0 });
      // 09-17: items 1, 2, 3, 7, 12 done; 6 in backlog; 8 in Todo; 10 in a state that no longer exists.
      expect(day("2026-09-17")).toEqual({ date: "2026-09-17", backlog: 1, unstarted: 1, started: 0, completed: 5, cancelled: 0, unknown: 1 });
      // 10-04: the closing snapshot reconciles silent state re-parks to today's board.
      expect(day("2026-10-04")).toEqual({ date: "2026-10-04", backlog: 1, unstarted: 2, started: 2, completed: 5, cancelled: 1, unknown: 0 });
    });

    it("lists the unknown band only when some day has one", async () => {
      const withUnknown = await getInsights(prisma, { projectId: p1, ...RANGE }, { now: NOW, timezone: "UTC" });
      expect(withUnknown.cumulativeFlow.groups).toContain("unknown");
      // Before item 10 moved into the deleted state, nothing is unknown.
      const before = await getInsights(
        prisma,
        { projectId: p1, from: "2026-09-07", to: "2026-09-16", groupBy: "day" },
        { now: NOW, timezone: "UTC" },
      );
      expect(before.cumulativeFlow.groups).toEqual(["backlog", "unstarted", "started", "completed", "cancelled"]);
    });

    it("carries the starting picture into a range that begins mid-history", async () => {
      const r = await getInsights(
        prisma,
        { projectId: p1, from: "2026-09-22", to: "2026-09-25", groupBy: "day" },
        { now: NOW, timezone: "UTC" },
      );
      expect(r.cumulativeFlow.days).toEqual(referenceCfd([p1], "2026-09-22", "2026-09-25"));
    });
  });

  describe("workload and aging (a snapshot of now)", () => {
    it("counts open items per assignee, with the unassigned row last among equals", async () => {
      const r = await getInsights(prisma, { projectId: p1, ...RANGE }, { now: NOW, timezone: "UTC" });
      // Open: 5 (A), 6 (A+B), 7 (B), 10 and 11 (nobody). An item with two owners counts for both.
      expect(r.workload.assignees.map((a) => [a.userId, a.openItems])).toEqual([
        [A, 2],
        [B, 2],
        [null, 2],
      ]);
    });

    it("lists in-progress items oldest first, restarting the clock only on a move INTO started", async () => {
      const r = await getInsights(prisma, { projectId: p1, ...RANGE }, { now: NOW, timezone: "UTC" });
      expect(r.agingWip.total).toBe(2);
      expect(r.agingWip.items).toEqual([
        // Re-opened 09-20 10:00: 14 days 2 hours.
        expect.objectContaining({ key: "WSA-7", stateName: "Doing", ageDays: 14.1, since: "2026-09-20T10:00:00.000Z" }),
        // Doing since 09-30 10:00: 4 days 2 hours.
        expect.objectContaining({ key: "WSA-5", stateName: "Doing", ageDays: 4.1, since: "2026-09-30T10:00:00.000Z" }),
      ]);
    });

    it("does not restart an item's clock when it moves between two started states", async () => {
      const project = await prisma.pmProject.create({
        data: { workspaceId: await scratchWorkspace(), identifier: "WSD", name: "WS8 Delta" },
      });
      const doing = await prisma.pmState.create({ data: { projectId: project.id, name: "Doing", group: "started" } });
      const review = await prisma.pmState.create({ data: { projectId: project.id, name: "Review", group: "started" } });
      const todo = await prisma.pmState.create({ data: { projectId: project.id, name: "Todo", group: "unstarted", isDefault: true } });
      const item = await prisma.pmWorkItem.create({
        data: { projectId: project.id, sequenceId: 1, name: "moved", stateId: review.id, createdAt: at("09-01") },
      });
      await prisma.pmActivity.createMany({
        data: [
          { workItemId: item.id, verb: "state_changed", oldValue: todo.id, newValue: doing.id, createdAt: at("09-05"), notifyStatus: "not_needed" },
          { workItemId: item.id, verb: "state_changed", oldValue: doing.id, newValue: review.id, createdAt: at("09-28"), notifyStatus: "not_needed" },
        ],
      });
      const r = await getInsights(prisma, { projectId: project.id, ...RANGE }, { now: NOW, timezone: "UTC" });
      // Started 09-05, not 09-28: the Doing → Review move is inside the started group.
      expect(r.agingWip.items[0]).toMatchObject({ key: "WSD-1", since: "2026-09-05T10:00:00.000Z" });
    });
  });

  describe("service-desk boundary", () => {
    it("rejects a desk by id and excludes its ticket from every workspace aggregate", async () => {
      const ws = await prisma.pmWorkspace.create({
        data: { slug: `ws8-service-${Date.now().toString(36)}`, name: "WS8 service boundary" },
      });
      const projectId = await buildProject(
        ws.id,
        "WSDP",
        "WS8 project",
        P2_STATES,
        [{ seq: 1, path: [[at("09-20"), "Todo"]] }],
        false,
      );
      const desk = await prisma.pmProject.create({
        data: {
          workspaceId: ws.id,
          kind: "SERVICE_DESK",
          name: "WS8 private desk",
          identifier: "WSDX",
        },
      });
      const state = await prisma.pmState.create({
        data: { projectId: desk.id, name: "Doing", group: "started", isDefault: true },
      });
      const ticket = await prisma.pmWorkItem.create({
        data: {
          projectId: desk.id,
          sequenceId: 1,
          name: "PRIVATE-TICKET-SUBJECT",
          stateId: state.id,
          createdAt: at("09-20"),
        },
      });
      await prisma.pmTicket.create({
        data: {
          workItemId: ticket.id,
          requesterKind: "USER",
          requesterUserId: "ws8-private-requester",
          requesterName: "Private requester",
          channel: "INTERNAL",
        },
      });
      await prisma.pmActivity.create({
        data: { workItemId: ticket.id, verb: "created", createdAt: at("09-20"), notifyStatus: "not_needed" },
      });

      await expect(
        getInsights(prisma, { projectId: desk.id, ...RANGE }, { now: NOW, timezone: "UTC" }),
      ).rejects.toThrow(PM_ERRORS.PROJECT_NOT_FOUND);
      const insight = await getInsights(
        prisma,
        { workspaceSlug: ws.slug, ...RANGE },
        { now: NOW, timezone: "UTC" },
      );
      expect(insight.meta).toMatchObject({ scope: "workspace", itemCount: 1 });
      expect(insight.createdVsCompleted.created).toBe(1);
      expect(insight.workload.assignees).toEqual([{ userId: null, openItems: 1, openEstimate: 0 }]);
      expect(insight.agingWip).toMatchObject({ total: 0, items: [] });
      expect(JSON.stringify(insight)).not.toContain(ticket.id);
      expect(JSON.stringify(insight)).not.toContain(ticket.name);
      expect(JSON.stringify(insight)).not.toContain("WSDX-1");
      const projectInsight = await getInsights(
        prisma,
        { projectId, ...RANGE },
        { now: NOW, timezone: "UTC" },
      );
      expect(projectInsight.meta).toMatchObject({ scope: "project", projectId, itemCount: 1 });
    });
  });

  describe("workspace scope", () => {
    it("adds every live project of the workspace and leaves the archived one out", async () => {
      const r = await getInsights(prisma, { workspaceSlug: slug, ...RANGE }, { now: NOW, timezone: "UTC" });
      expect(r.meta).toMatchObject({ scope: "workspace", projectId: null, itemCount: 14 }); // 11 + 3
      expect(r.throughput.buckets.map((b) => b.completed)).toEqual([1, 2, 1, 1]); // + project 2's item 1 in 09-28
      expect(r.createdVsCompleted.created).toBe(12); // 9 + 3
      expect(r.leadTime).toMatchObject({ count: 5, p50: 3 }); // 9, 9, 2, 3, 3
      expect(r.cycleTime).toMatchObject({ count: 4, p50: 2.5 }); // 2, 8, 3, 2
      expect(r.workload.assignees.map((a) => [a.userId, a.openItems])).toEqual([
        [null, 3], // items 10, 11 and project 2's item 2
        [A, 2],
        [B, 2],
      ]);
      expect(r.cumulativeFlow.days).toEqual(referenceCfd([p1, p2], "2026-09-07", "2026-10-04"));
    });

    it("is a valid, empty answer for a workspace with no projects", async () => {
      const r = await getInsights(
        prisma,
        { workspaceSlug: "ws8-does-not-exist", ...RANGE },
        { now: NOW, timezone: "UTC" },
      );
      expect(r.meta.itemCount).toBe(0);
      expect(r.throughput.buckets).toHaveLength(4);
      expect(r.throughput.total).toBe(0);
      expect(r.cumulativeFlow.days).toHaveLength(28);
      expect(r.workload.assignees).toEqual([]);
      expect(r.agingWip).toEqual({ total: 0, items: [] });
    });

    it("refuses an unknown project", async () => {
      await expect(
        getInsights(prisma, { projectId: "no-such-project", ...RANGE }, { now: NOW, timezone: "UTC" }),
      ).rejects.toThrow(PM_ERRORS.PROJECT_NOT_FOUND);
    });
  });

  describe("range and buckets", () => {
    it("rounds `from` out to the start of its week and says so", async () => {
      const r = await getInsights(
        prisma,
        { projectId: p1, from: "2026-09-10", to: "2026-10-04", groupBy: "week" },
        { now: NOW, timezone: "UTC" },
      );
      expect(r.meta.from).toBe("2026-09-07");
      expect(r.throughput.buckets[0].start).toBe("2026-09-07");
    });

    it("buckets by day and by month", async () => {
      const day = await getInsights(prisma, { projectId: p1, ...RANGE, groupBy: "day" }, { now: NOW, timezone: "UTC" });
      expect(day.throughput.buckets).toHaveLength(28);
      expect(day.throughput.buckets.find((b) => b.start === "2026-09-17")?.completed).toBe(2);
      const month = await getInsights(prisma, { projectId: p1, ...RANGE, groupBy: "month" }, { now: NOW, timezone: "UTC" });
      expect(month.meta.from).toBe("2026-09-01");
      expect(month.throughput.buckets).toEqual([
        { start: "2026-09-01", completed: 4 },
        { start: "2026-10-01", completed: 0 },
      ]);
    });

    it("clamps `to` to today and refuses an inverted range", async () => {
      const r = await getInsights(
        prisma,
        { projectId: p1, from: "2026-09-07", to: "2026-12-31", groupBy: "week" },
        { now: NOW, timezone: "UTC" },
      );
      expect(r.meta.to).toBe("2026-10-04");
      await expect(
        getInsights(prisma, { projectId: p1, from: "2026-10-04", to: "2026-09-07", groupBy: "day" }, { now: NOW, timezone: "UTC" }),
      ).rejects.toThrow(INSIGHTS_ERRORS.INVALID_RANGE);
    });
  });

  describe("the workspace's own calendar", () => {
    async function singleItemProject(completedAt: Date[]): Promise<string> {
      const project = await prisma.pmProject.create({
        data: { workspaceId: await scratchWorkspace(), identifier: "WSE", name: "WS8 Epsilon" },
      });
      const done = await prisma.pmState.create({ data: { projectId: project.id, name: "Done", group: "completed", isDefault: true } });
      let seq = 1;
      for (const when of completedAt) {
        await prisma.pmWorkItem.create({
          data: {
            projectId: project.id,
            sequenceId: seq++,
            name: `done-${seq}`,
            stateId: done.id,
            createdAt: new Date(when.getTime() - 3_600_000),
            isCompleted: true,
            completedAt: when,
          },
        });
      }
      return project.id;
    }

    it("puts a Sunday-evening finish in the week it happened in Los Angeles, not in UTC's Monday", async () => {
      // 2026-09-14T06:30Z is Monday in UTC and 2026-09-13 23:30 on Sunday in Pacific time.
      const id = await singleItemProject([new Date("2026-09-14T06:30:00.000Z")]);
      const q = { projectId: id, from: "2026-09-01", to: "2026-09-27", groupBy: "week" as const };
      const utc = await getInsights(prisma, q, { now: NOW, timezone: "UTC" });
      expect(utc.throughput.buckets.find((b) => b.completed === 1)?.start).toBe("2026-09-14");
      clearInsightsCache();
      const la = await getInsights(prisma, q, { now: NOW, timezone: "America/Los_Angeles" });
      expect(la.meta.timezone).toBe("America/Los_Angeles");
      expect(la.throughput.buckets.find((b) => b.completed === 1)?.start).toBe("2026-09-07");
    });

    it("buckets days correctly across the 25-hour fall-back day", async () => {
      // Los Angeles falls back on 2026-11-01 at 02:00 PDT: that local day runs 07:00Z to 08:00Z the next day.
      const id = await singleItemProject([
        new Date("2026-11-01T06:59:00.000Z"), // 10-31 23:59 PDT
        new Date("2026-11-01T07:01:00.000Z"), // 11-01 00:01 PDT
        new Date("2026-11-02T07:59:00.000Z"), // 11-01 23:59 PST
        new Date("2026-11-02T08:01:00.000Z"), // 11-02 00:01 PST
      ]);
      const r = await getInsights(
        prisma,
        { projectId: id, from: "2026-10-30", to: "2026-11-03", groupBy: "day" },
        { now: new Date("2026-11-03T18:00:00.000Z"), timezone: "America/Los_Angeles" },
      );
      expect(r.throughput.buckets).toEqual([
        { start: "2026-10-30", completed: 0 },
        { start: "2026-10-31", completed: 1 },
        { start: "2026-11-01", completed: 2 },
        { start: "2026-11-02", completed: 1 },
        { start: "2026-11-03", completed: 0 },
      ]);
    });

    it("rejects POSIX offsets before they can reverse meaning in Postgres", async () => {
      const result = await getInsights(
        prisma,
        { projectId: p1, ...RANGE },
        { now: NOW, timezone: "+05:30" },
      );
      expect(result.meta.timezone).not.toBe("+05:30");
      expect(result.cumulativeFlow.days).toHaveLength(28);
    });
  });

  describe("estimates (WARP-3520 adds the column; this slice must not need it)", () => {
    it("sums open estimates per assignee once the column exists, and says when it does not", async () => {
      const probe = async () =>
        (
          await prisma.$queryRaw<Array<{ present: boolean }>>`
            SELECT EXISTS (SELECT 1 FROM information_schema.columns
                            WHERE table_schema = current_schema() AND table_name = 'PmWorkItem' AND column_name = 'estimate') AS present`
        )[0].present;
      const existed = await probe();

      const before = await getInsights(prisma, { projectId: p1, ...RANGE }, { now: NOW, timezone: "UTC" });
      expect(before.workload.estimateAvailable).toBe(existed);

      if (!existed) await prisma.$executeRawUnsafe(`ALTER TABLE "PmWorkItem" ADD COLUMN IF NOT EXISTS "estimate" double precision`);
      try {
        // Item 5 (A) = 3 points, item 6 (A and B) = 5, item 7 (B) = 2; item 10 (unassigned) = 8; item 8 is cancelled.
        for (const [seq, points] of [[5, 3], [6, 5], [7, 2], [10, 8], [8, 100]] as const) {
          await prisma.$executeRaw`UPDATE "PmWorkItem" SET "estimate" = ${points} WHERE "projectId" = ${p1} AND "sequenceId" = ${seq}`;
        }
        clearInsightsCache();
        const after = await getInsights(prisma, { projectId: p1, ...RANGE }, { now: NOW, timezone: "UTC" });
        expect(after.workload.estimateAvailable).toBe(true);
        expect(after.workload.assignees.map((a) => [a.userId, a.openItems, a.openEstimate])).toEqual([
          [A, 2, 8], // 3 + 5
          [B, 2, 7], // 5 + 2
          [null, 2, 8], // item 10 = 8, item 11 has none
        ]);
      } finally {
        await prisma.$executeRaw`UPDATE "PmWorkItem" SET "estimate" = NULL WHERE "projectId" = ${p1}`;
        if (!existed) await prisma.$executeRawUnsafe(`ALTER TABLE "PmWorkItem" DROP COLUMN IF EXISTS "estimate"`);
      }
    });
  });

  describe("cache", () => {
    it("serves the same answer for five minutes whatever happens underneath, then recomputes", async () => {
      const q = { projectId: p1, ...RANGE };
      const first = await getInsights(prisma, q, { now: NOW, timezone: "UTC" });
      const row = await prisma.pmWorkItem.create({
        data: { projectId: p1, sequenceId: 99, name: "late arrival", createdAt: at("10-02"), stateId: null },
      });
      try {
        const cached = await getInsights(prisma, q, { now: new Date(NOW.getTime() + INSIGHTS_CACHE_TTL_MS - 1), timezone: "UTC" });
        expect(cached).toBe(first);
        expect(cached.meta.itemCount).toBe(11);

        const fresh = await getInsights(prisma, q, { now: new Date(NOW.getTime() + INSIGHTS_CACHE_TTL_MS), timezone: "UTC" });
        expect(fresh).not.toBe(first);
        expect(fresh.meta.itemCount).toBe(12);
        expect(fresh.meta.generatedAt).toBe(new Date(NOW.getTime() + INSIGHTS_CACHE_TTL_MS).toISOString());
      } finally {
        await prisma.pmWorkItem.delete({ where: { id: row.id } });
      }
    });

    it("keeps a separate entry per range and per project", async () => {
      const a = await getInsights(prisma, { projectId: p1, ...RANGE }, { now: NOW, timezone: "UTC" });
      const b = await getInsights(prisma, { projectId: p2, ...RANGE }, { now: NOW, timezone: "UTC" });
      const c = await getInsights(prisma, { projectId: p1, ...RANGE, from: "2026-09-14" }, { now: NOW, timezone: "UTC" });
      expect(new Set([a, b, c]).size).toBe(3);
      expect(a.meta.projectId).toBe(p1);
      expect(b.meta.projectId).toBe(p2);
      expect(c.meta.from).toBe("2026-09-14");
    });
  });

  describe("summary: unassigned (ADR-044 follow-up)", () => {
    it("counts open work nobody owns, alongside the existing counts", async () => {
      const s = await getSummary(prisma, slug, NOW);
      expect(s).toEqual({
        activeProjects: 2, // the archived project is out
        itemsOpen: 6, // project 1: 5, 6, 7, 10, 11 (11 has no state); project 2: item 2
        doneThisWeek: 2, // project 2's item 1 (done 10-02) and item 3 (cancelled 10-03, which counts as before)
        overdue: 2, // project 1's item 5 and project 2's item 2; item 6 is due next week, item 1 is done
        unassigned: 3, // project 1's items 10 and 11, project 2's item 2
      });
    });

    it("is zero everywhere for a workspace with nothing in it", async () => {
      expect(await getSummary(prisma, "ws8-does-not-exist", NOW)).toEqual({
        activeProjects: 0,
        itemsOpen: 0,
        doneThisWeek: 0,
        overdue: 0,
        unassigned: 0,
      });
    });
  });
});
