/**
 * WARP-3521 (ADR-069 slice WS-5) — what only a real database can prove about
 * cycles and modules.
 *
 * A mocked Prisma will accept every row these guarantees exist to reject, so a
 * green unit suite says nothing about them:
 *
 *   1. AT MOST ONE ACTIVE CYCLE PER PROJECT is a partial unique index. It is
 *      the one thing standing between two racing "Start" clicks and a project
 *      with two running sprints, and it can only be exercised against Postgres.
 *   2. The two CHECKs (end never before start), and the two same-project
 *      TRIGGERS (an item's cycle, a module's items) — a CHECK may not contain a
 *      subquery, so these are triggers, and a trigger is invisible to every
 *      layer above it.
 *   3. `completeCycle` — "completing a cycle never leaves an incomplete item
 *      attached to it" — as a transaction (rolls back whole), under concurrency
 *      (an item planned into the cycle while it completes), and against the real
 *      SSI behaviour of SERIALIZABLE.
 *   4. The burndown over a fixture, and the contract between the rows the
 *      SERVICES write and the rows the burndown READS — which no mock can see,
 *      because a mock agrees with whatever the author assumed.
 *
 * Gated like every other `*.pg.test.ts`: real Postgres, RUN_PG_INTEGRATION=1.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import * as pm from "../services/pm/pm.service.js";
import * as cycles from "../services/pm/pm-cycles.service.js";
import * as modules from "../services/pm/pm-modules.service.js";
import { formatDateOnly, parseDateOnly } from "../services/pm/pm-planning.js";
import { PRISMA_DIR } from "./helpers/test-paths.js";

// The global unit setup mocks @prisma/client so the DB-less lane never needs
// Postgres. This file must talk to a REAL one.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("cycles and modules — the database's own guarantees (WARP-3521)", () => {
  let prisma: PrismaClient;

  // Every fixture is namespaced `warp3521-`: the pg-gated suites share one
  // throwaway database and run in the same lane, so an unscoped deleteMany()
  // would eat another suite's rows.
  const OURS = { startsWith: "warp3521-" } as const;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<
      typeof import("@prisma/client")
    >("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function cleanup() {
    // Projects cascade to cycles, modules, items, links and activity.
    await prisma.pmProject.deleteMany({ where: { name: OURS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
  }

  let projectA = "";
  let projectB = "";
  let statesA: Record<"todo" | "doing" | "done" | "cancelled", string>;
  let seq = 0;

  beforeEach(async () => {
    await cleanup();
    const ws = await prisma.pmWorkspace.create({
      data: { slug: `warp3521-ws-${Date.now()}`, name: "warp3521-ws" },
    });
    const a = await prisma.pmProject.create({
      data: { workspaceId: ws.id, name: "warp3521-alpha", identifier: "W35A" },
    });
    const b = await prisma.pmProject.create({
      data: { workspaceId: ws.id, name: "warp3521-bravo", identifier: "W35B" },
    });
    projectA = a.id;
    projectB = b.id;
    const mk = (name: string, group: "unstarted" | "started" | "completed" | "cancelled", isDefault = false) =>
      prisma.pmState.create({ data: { projectId: projectA, name, group, isDefault, sortOrder: ++seq } });
    const [todo, doing, done, cancelled] = [
      await mk("Todo", "unstarted", true),
      await mk("Doing", "started"),
      await mk("Done", "completed"),
      await mk("Cancelled", "cancelled"),
    ];
    statesA = { todo: todo.id, doing: doing.id, done: done.id, cancelled: cancelled.id };
  });

  // ── fixtures ────────────────────────────────────────────────────────────────

  const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  const cycle = (
    projectId: string,
    over: Partial<{ name: string; status: "draft" | "active" | "completed"; startDate: Date | null; endDate: Date | null }> = {},
  ) =>
    prisma.pmCycle.create({
      data: {
        projectId,
        name: `warp3521-${over.name ?? "cycle"}`,
        status: over.status ?? "draft",
        startDate: over.startDate === undefined ? d("2026-10-05") : over.startDate,
        endDate: over.endDate === undefined ? d("2026-10-16") : over.endDate,
      },
    });

  const item = (
    projectId: string,
    over: Partial<{
      name: string;
      cycleId: string | null;
      stateId: string | null;
      isCompleted: boolean;
      isArchived: boolean;
      estimate: number | null;
    }> = {},
  ) =>
    prisma.pmWorkItem.create({
      data: {
        projectId,
        sequenceId: ++seq,
        name: `warp3521-${over.name ?? "item"}`,
        cycleId: over.cycleId ?? null,
        stateId: over.stateId === undefined ? statesA.todo : over.stateId,
        isCompleted: over.isCompleted ?? false,
        isArchived: over.isArchived ?? false,
        estimate: over.estimate ?? null,
      },
    });

  const moduleRow = (projectId: string, over: Partial<{ name: string; startDate: Date | null; targetDate: Date | null }> = {}) =>
    prisma.pmModule.create({
      data: {
        projectId,
        name: `warp3521-${over.name ?? "module"}`,
        startDate: over.startDate ?? null,
        targetDate: over.targetDate ?? null,
      },
    });

  const refusedBy = (p: Promise<unknown>, pattern: RegExp | string) =>
    expect(p).rejects.toThrow(pattern);

  // ═══ 1. at most one ACTIVE cycle per project ═════════════════════════════════

  describe("the partial unique index PmCycle_projectId_active_key", () => {
    it("is partial: it is scoped to status = 'active' in the catalog", async () => {
      const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
        SELECT indexdef FROM pg_indexes WHERE indexname = 'PmCycle_projectId_active_key'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toMatch(/UNIQUE/i);
      expect(rows[0].indexdef).toMatch(/WHERE.*status.*active/i);
    });

    it("refuses a second active cycle in the same project (insert)", async () => {
      await cycle(projectA, { name: "one", status: "active" });
      await refusedBy(cycle(projectA, { name: "two", status: "active" }), /Unique constraint|PmCycle_projectId_active_key/i);
    });

    it("refuses promoting a second cycle to active (update) — this is the race a double-click opens", async () => {
      await cycle(projectA, { name: "running", status: "active" });
      const waiting = await cycle(projectA, { name: "waiting" });
      await refusedBy(
        prisma.pmCycle.update({ where: { id: waiting.id }, data: { status: "active" } }),
        /Unique constraint|PmCycle_projectId_active_key/i,
      );
      expect((await prisma.pmCycle.findUnique({ where: { id: waiting.id } }))!.status).toBe("draft");
    });

    it("any number of draft and completed cycles sit beside the one active", async () => {
      await cycle(projectA, { name: "d1" });
      await cycle(projectA, { name: "d2" });
      await cycle(projectA, { name: "c1", status: "completed" });
      await cycle(projectA, { name: "c2", status: "completed" });
      await expect(cycle(projectA, { name: "a", status: "active" })).resolves.toBeTruthy();
    });

    it("each project has its own one", async () => {
      await cycle(projectA, { name: "a", status: "active" });
      await expect(cycle(projectB, { name: "b", status: "active" })).resolves.toBeTruthy();
    });

    it("completing the active cycle frees the slot", async () => {
      const first = await cycle(projectA, { name: "first", status: "active" });
      const second = await cycle(projectA, { name: "second" });
      await prisma.pmCycle.update({ where: { id: first.id }, data: { status: "completed" } });
      await expect(
        prisma.pmCycle.update({ where: { id: second.id }, data: { status: "active" } }),
      ).resolves.toBeTruthy();
    });

    it("startCycle maps the index's refusal onto cycle_already_active, naming the one in the way", async () => {
      const running = await cycle(projectA, { name: "running", status: "active" });
      const next = await cycle(projectA, { name: "next" });
      const err = await cycles.startCycle(prisma, next.id).catch((e) => e);
      expect(err.message).toBe("cycle_already_active");
      expect(err.details).toMatchObject({ activeCycleId: running.id });
    });

    it("two Start clicks that race each other leave exactly ONE active cycle", async () => {
      for (let round = 0; round < 5; round += 1) {
        await cleanupCycles();
        const a = await cycle(projectA, { name: `a${round}` });
        const b = await cycle(projectA, { name: `b${round}` });
        const results = await Promise.allSettled([
          cycles.startCycle(prisma, a.id),
          cycles.startCycle(prisma, b.id),
        ]);
        const won = results.filter((r) => r.status === "fulfilled");
        const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        expect(won, `round ${round}`).toHaveLength(1);
        expect(lost, `round ${round}`).toHaveLength(1);
        expect(lost[0].reason.message).toBe("cycle_already_active");
        expect(await prisma.pmCycle.count({ where: { projectId: projectA, status: "active" } })).toBe(1);
      }
    });

    async function cleanupCycles() {
      await prisma.pmCycle.deleteMany({ where: { projectId: projectA } });
    }
  });

  // ═══ 2. CHECKs and triggers ══════════════════════════════════════════════════

  describe("PmCycle_dates_ordered / PmModule_dates_ordered", () => {
    it("a cycle's end can never be before its start", async () => {
      await refusedBy(
        cycle(projectA, { startDate: d("2026-10-16"), endDate: d("2026-10-05") }),
        /PmCycle_dates_ordered|check constraint/i,
      );
      const c = await cycle(projectA);
      await refusedBy(
        prisma.pmCycle.update({ where: { id: c.id }, data: { endDate: d("2026-10-01") } }),
        /PmCycle_dates_ordered|check constraint/i,
      );
    });

    it("a one-day cycle, and a cycle with a missing end, are fine", async () => {
      await expect(cycle(projectA, { startDate: d("2026-10-05"), endDate: d("2026-10-05") })).resolves.toBeTruthy();
      await expect(cycle(projectA, { startDate: d("2026-10-05"), endDate: null })).resolves.toBeTruthy();
      await expect(cycle(projectA, { startDate: null, endDate: d("2026-10-05") })).resolves.toBeTruthy();
    });

    it("a module's target can never be before its start", async () => {
      await refusedBy(
        moduleRow(projectA, { startDate: d("2026-12-01"), targetDate: d("2026-10-05") }),
        /PmModule_dates_ordered|check constraint/i,
      );
      await expect(moduleRow(projectA, { startDate: d("2026-10-05"), targetDate: d("2026-10-05") })).resolves.toBeTruthy();
    });
  });

  describe("pmworkitem_cycle_same_project — an item's cycle belongs to the item's project", () => {
    it("refuses an item created in another project's cycle", async () => {
      const foreign = await cycle(projectB, { name: "foreign" });
      await refusedBy(item(projectA, { cycleId: foreign.id }), /own project|WARP-3521/i);
    });

    it("refuses pointing an existing item at another project's cycle (UPDATE OF cycleId)", async () => {
      const foreign = await cycle(projectB, { name: "foreign" });
      const mine = await item(projectA);
      await refusedBy(
        prisma.pmWorkItem.update({ where: { id: mine.id }, data: { cycleId: foreign.id } }),
        /own project|WARP-3521/i,
      );
      expect((await prisma.pmWorkItem.findUnique({ where: { id: mine.id } }))!.cycleId).toBeNull();
    });

    it("refuses moving an item to another project while it stays in this project's cycle (UPDATE OF projectId)", async () => {
      const mine = await cycle(projectA, { name: "mine" });
      const it = await item(projectA, { cycleId: mine.id });
      // No write path sets projectId today; that is exactly why it is pinned.
      await refusedBy(
        prisma.pmWorkItem.update({ where: { id: it.id }, data: { projectId: projectB } }),
        /own project|WARP-3521/i,
      );
    });

    it("allows a same-project cycle, and a null one", async () => {
      const mine = await cycle(projectA, { name: "mine" });
      await expect(item(projectA, { cycleId: mine.id })).resolves.toBeTruthy();
      await expect(item(projectA, { cycleId: null })).resolves.toBeTruthy();
    });

    it("a cycle that does not exist is the FOREIGN KEY's refusal, not the trigger's", async () => {
      await refusedBy(item(projectA, { cycleId: "no-such-cycle" }), /Foreign key|fkey/i);
    });

    it("deleting a cycle detaches its items (SET NULL passes the trigger) and destroys no work", async () => {
      const c = await cycle(projectA, { name: "doomed" });
      const it = await item(projectA, { cycleId: c.id });
      await prisma.pmCycle.delete({ where: { id: c.id } });
      expect((await prisma.pmWorkItem.findUnique({ where: { id: it.id } }))!.cycleId).toBeNull();
    });
  });

  describe("pmmoduleworkitem_same_project — a module's items belong to the module's project", () => {
    it("refuses linking an item of another project", async () => {
      const m = await moduleRow(projectA);
      // projectB has no states of its own; an item with no state is fine
      const other = await prisma.pmWorkItem.create({ data: { projectId: projectB, sequenceId: ++seq, name: "warp3521-foreign" } });
      await refusedBy(
        prisma.pmModuleWorkItem.create({ data: { moduleId: m.id, workItemId: other.id } }),
        /same project|WARP-3521/i,
      );
    });

    it("refuses re-pointing an existing link across the project boundary (UPDATE OF workItemId)", async () => {
      const m = await moduleRow(projectA);
      const mine = await item(projectA);
      const link = await prisma.pmModuleWorkItem.create({ data: { moduleId: m.id, workItemId: mine.id } });
      const other = await prisma.pmWorkItem.create({ data: { projectId: projectB, sequenceId: ++seq, name: "warp3521-foreign" } });
      await refusedBy(
        prisma.pmModuleWorkItem.update({ where: { id: link.id }, data: { workItemId: other.id } }),
        /same project|WARP-3521/i,
      );
    });

    it("allows same-project links, and an item in several modules", async () => {
      const m1 = await moduleRow(projectA, { name: "m1" });
      const m2 = await moduleRow(projectA, { name: "m2" });
      const it = await item(projectA);
      await prisma.pmModuleWorkItem.create({ data: { moduleId: m1.id, workItemId: it.id } });
      await expect(prisma.pmModuleWorkItem.create({ data: { moduleId: m2.id, workItemId: it.id } })).resolves.toBeTruthy();
    });

    it("deleting a module takes its links, not its items", async () => {
      const m = await moduleRow(projectA);
      const it = await item(projectA);
      await prisma.pmModuleWorkItem.create({ data: { moduleId: m.id, workItemId: it.id } });
      await prisma.pmModule.delete({ where: { id: m.id } });
      expect(await prisma.pmModuleWorkItem.count({ where: { workItemId: it.id } })).toBe(0);
      expect(await prisma.pmWorkItem.findUnique({ where: { id: it.id } })).not.toBeNull();
    });
  });

  describe("the migration's repair statements do what the header says", () => {
    // The repair passes run against ZERO rows on every real box, because no
    // shipped path could write a violation. That makes them the least-tested SQL
    // in the file — so each one is pulled out of the migration text and run
    // against a real violation (made by switching the guard off for a moment).
    const dirs = readdirSync(join(PRISMA_DIR, "migrations")).filter((x) => x.endsWith("_warp_3521_pm_cycles_modules"));
    const sql = readFileSync(join(PRISMA_DIR, "migrations", dirs[0], "migration.sql"), "utf8");
    const statement = (re: RegExp): string => {
      const m = re.exec(sql);
      expect(m, `migration must contain a statement matching ${re}`).not.toBeNull();
      return m![0].replace(/;\s*$/, "");
    };

    it("a work item in another project's cycle is detached, and the detach is audited", async () => {
      const foreign = await cycle(projectB, { name: "foreign" });
      const victim = await item(projectA);
      await prisma.$executeRawUnsafe(`ALTER TABLE "PmWorkItem" DISABLE TRIGGER pmworkitem_cycle_same_project`);
      try {
        await prisma.$executeRawUnsafe(`UPDATE "PmWorkItem" SET "cycleId" = '${foreign.id}' WHERE id = '${victim.id}'`);
        await prisma.$executeRawUnsafe(statement(/INSERT INTO "PmActivity"(?:(?!INSERT INTO)[\s\S])*?'cycle_removed'[\s\S]*?WHERE c\."projectId" <> w\."projectId";/));
        await prisma.$executeRawUnsafe(statement(/UPDATE "PmWorkItem" w\s+SET "cycleId" = NULL[\s\S]*?c\."projectId" <> w\."projectId";/));
      } finally {
        await prisma.$executeRawUnsafe(`ALTER TABLE "PmWorkItem" ENABLE TRIGGER pmworkitem_cycle_same_project`);
      }
      expect((await prisma.pmWorkItem.findUnique({ where: { id: victim.id } }))!.cycleId).toBeNull();
      const audit = await prisma.pmActivity.findMany({ where: { workItemId: victim.id, verb: "cycle_removed" } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ field: "cycle", oldValue: foreign.id, newValue: null, actorId: null });
    });

    it("a cross-project module link is deleted, and audited", async () => {
      const m = await moduleRow(projectA);
      const other = await prisma.pmWorkItem.create({ data: { projectId: projectB, sequenceId: ++seq, name: "warp3521-foreign" } });
      await prisma.$executeRawUnsafe(`ALTER TABLE "PmModuleWorkItem" DISABLE TRIGGER pmmoduleworkitem_same_project`);
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "PmModuleWorkItem" ("id","moduleId","workItemId") VALUES ('warp3521-link', '${m.id}', '${other.id}')`,
        );
        await prisma.$executeRawUnsafe(statement(/INSERT INTO "PmActivity"(?:(?!INSERT INTO)[\s\S])*?'module_removed'[\s\S]*?WHERE m\."projectId" <> w\."projectId";/));
        await prisma.$executeRawUnsafe(statement(/DELETE FROM "PmModuleWorkItem" mw[\s\S]*?m\."projectId" <> w\."projectId";/));
      } finally {
        await prisma.$executeRawUnsafe(`ALTER TABLE "PmModuleWorkItem" ENABLE TRIGGER pmmoduleworkitem_same_project`);
      }
      expect(await prisma.pmModuleWorkItem.count({ where: { moduleId: m.id } })).toBe(0);
      const audit = await prisma.pmActivity.findMany({ where: { workItemId: other.id, verb: "module_removed" } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ field: "module", oldValue: m.id, newValue: null });
    });

    it("inverted dates are repaired to the start date before the CHECK would refuse them", async () => {
      const c = await cycle(projectA, { name: "inverted" });
      await prisma.$executeRawUnsafe(`ALTER TABLE "PmCycle" DROP CONSTRAINT "PmCycle_dates_ordered"`);
      try {
        await prisma.$executeRawUnsafe(`UPDATE "PmCycle" SET "endDate" = '2026-10-01' WHERE id = '${c.id}'`);
        await prisma.$executeRawUnsafe(statement(/UPDATE "PmCycle"\s+SET "endDate" = "startDate"[\s\S]*?"endDate" < "startDate";/));
      } finally {
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "PmCycle" ADD CONSTRAINT "PmCycle_dates_ordered" CHECK ("startDate" IS NULL OR "endDate" IS NULL OR "endDate" >= "startDate")`,
        );
      }
      const fixed = await prisma.pmCycle.findUnique({ where: { id: c.id } });
      expect(formatDateOnly(fixed!.endDate)).toBe("2026-10-05");
    });

    it("a duplicated active cycle is reverted to draft by the dedupe pass, newest kept", async () => {
      const older = await cycle(projectA, { name: "older", status: "active" });
      await prisma.$executeRawUnsafe(`DROP INDEX "PmCycle_projectId_active_key"`);
      let newer;
      try {
        newer = await cycle(projectA, { name: "newer", status: "active" });
        await prisma.$executeRawUnsafe(`UPDATE "PmCycle" SET "createdAt" = now() - interval '1 day' WHERE id = '${older.id}'`);
        await prisma.$executeRawUnsafe(
          statement(/WITH ranked AS \([\s\S]*?\)\s+UPDATE "PmCycle"[\s\S]*?WHERE rn > 1\);/),
        );
      } finally {
        await prisma.$executeRawUnsafe(
          `CREATE UNIQUE INDEX IF NOT EXISTS "PmCycle_projectId_active_key" ON "PmCycle"("projectId") WHERE "status" = 'active'`,
        );
      }
      expect((await prisma.pmCycle.findUnique({ where: { id: older.id } }))!.status).toBe("draft");
      expect((await prisma.pmCycle.findUnique({ where: { id: newer!.id } }))!.status).toBe("active");
    });
  });

  // ═══ 3. completing a cycle ═══════════════════════════════════════════════════

  describe("completeCycle", () => {
    async function sprint() {
      const c = await cycle(projectA, { name: "sprint", status: "active" });
      const done = await item(projectA, { name: "done", cycleId: c.id, stateId: statesA.done, isCompleted: true });
      const cancelled = await item(projectA, { name: "cancelled", cycleId: c.id, stateId: statesA.cancelled, isCompleted: true });
      const todo = await item(projectA, { name: "todo", cycleId: c.id });
      const doing = await item(projectA, { name: "doing", cycleId: c.id, stateId: statesA.doing });
      const hidden = await item(projectA, { name: "hidden", cycleId: c.id, isArchived: true });
      const bystander = await item(projectA, { name: "bystander" });
      return { c, done, cancelled, todo, doing, hidden, bystander };
    }

    const cycleOf = async (id: string) => (await prisma.pmWorkItem.findUnique({ where: { id } }))!.cycleId;
    const attachedOpen = (cycleId: string) =>
      prisma.pmWorkItem.count({ where: { cycleId, isCompleted: false } });

    it("AC: never leaves an incomplete item attached — to the backlog", async () => {
      const s = await sprint();
      const out = await cycles.completeCycle(prisma, "u1", s.c.id, { moveIncompleteTo: null });

      expect(await attachedOpen(s.c.id)).toBe(0);
      expect(await cycleOf(s.todo.id)).toBeNull();
      expect(await cycleOf(s.doing.id)).toBeNull();
      expect(await cycleOf(s.hidden.id)).toBeNull(); // hidden is not finished
      expect(await cycleOf(s.done.id)).toBe(s.c.id); // the record of what it delivered stays
      expect(await cycleOf(s.cancelled.id)).toBe(s.c.id);
      expect(await cycleOf(s.bystander.id)).toBeNull();
      expect(out.moved).toEqual({ count: 3, to: null });
      expect(out.cycle).toMatchObject({ status: "completed", carriedOverCount: 2 });
      expect(out.cycle.completedAt).not.toBeNull();
      expect(out.cycle.progress).toMatchObject({ total: 2, completed: 1, cancelled: 1 });
    });

    it("AC: …and into another cycle", async () => {
      const s = await sprint();
      const next = await cycle(projectA, { name: "next", startDate: d("2026-10-19"), endDate: d("2026-10-30") });
      const out = await cycles.completeCycle(prisma, "u1", s.c.id, { moveIncompleteTo: next.id });
      expect(await attachedOpen(s.c.id)).toBe(0);
      expect(await cycleOf(s.todo.id)).toBe(next.id);
      expect(await cycleOf(s.doing.id)).toBe(next.id);
      expect(await cycleOf(s.hidden.id)).toBe(next.id);
      expect(out.moved).toEqual({ count: 3, to: next.id });
      expect((await cycles.getCycle(prisma, next.id)).progress.total).toBe(2); // the hidden one is not counted
    });

    it("writes ONE activity row per moved item — a cycle_removed to the backlog, a cycle_added {from → to} to another cycle", async () => {
      const s = await sprint();
      await cycles.completeCycle(prisma, "u1", s.c.id, { moveIncompleteTo: null });
      const rows = await prisma.pmActivity.findMany({ where: { verb: "cycle_removed", oldValue: s.c.id } });
      expect(rows.map((r) => r.workItemId).sort()).toEqual([s.todo.id, s.doing.id, s.hidden.id].sort());
      for (const r of rows) expect(r).toMatchObject({ actorId: "u1", field: "cycle", newValue: null });

      const t = await sprint();
      const next = await cycle(projectA, { name: "next2" });
      await cycles.completeCycle(prisma, "u1", t.c.id, { moveIncompleteTo: next.id });
      const moved = await prisma.pmActivity.findMany({ where: { verb: "cycle_added", oldValue: t.c.id, newValue: next.id } });
      expect(moved.map((r) => r.workItemId).sort()).toEqual([t.todo.id, t.doing.id, t.hidden.id].sort());
    });

    it("is ONE transaction: a bad target leaves the cycle active and every item exactly where it was", async () => {
      const s = await sprint();
      const foreign = await cycle(projectB, { name: "foreign" });
      const finished = await cycle(projectA, { name: "old", status: "completed" });
      for (const target of [foreign.id, finished.id, "no-such-cycle", s.c.id]) {
        await expect(cycles.completeCycle(prisma, "u1", s.c.id, { moveIncompleteTo: target })).rejects.toThrow();
        expect((await prisma.pmCycle.findUnique({ where: { id: s.c.id } }))!.status).toBe("active");
        expect(await cycleOf(s.todo.id)).toBe(s.c.id);
        expect(await cycleOf(s.doing.id)).toBe(s.c.id);
        expect(await cycleOf(s.hidden.id)).toBe(s.c.id);
      }
      expect(await prisma.pmActivity.count({ where: { verb: { in: ["cycle_added", "cycle_removed"] } } })).toBe(0);
    });

    it("a draft or an already-completed cycle cannot be completed", async () => {
      const draft = await cycle(projectA, { name: "draft" });
      await expect(cycles.completeCycle(prisma, "u1", draft.id, { moveIncompleteTo: null })).rejects.toThrow("cycle_not_active");
      const s = await sprint();
      await cycles.completeCycle(prisma, "u1", s.c.id, { moveIncompleteTo: null });
      await expect(cycles.completeCycle(prisma, "u1", s.c.id, { moveIncompleteTo: null })).rejects.toThrow("cycle_not_active");
    });

    it("AC under concurrency: an item planned into the cycle WHILE it completes is moved with the rest, or refused — never stranded", async () => {
      for (let round = 0; round < 12; round += 1) {
        await prisma.pmCycle.deleteMany({ where: { projectId: projectA } });
        const c = await cycle(projectA, { name: `race${round}`, status: "active" });
        await item(projectA, { name: `seed${round}`, cycleId: c.id });
        const late = await item(projectA, { name: `late${round}` });

        const results = await Promise.allSettled([
          cycles.completeCycle(prisma, "u1", c.id, { moveIncompleteTo: null }),
          pm.updateWorkItem(prisma, "u2", late.id, { cycleId: c.id }),
        ]);

        // Whatever the interleaving, the one thing that must hold:
        const cycleNow = await prisma.pmCycle.findUnique({ where: { id: c.id } });
        if (cycleNow!.status === "completed") {
          expect(await attachedOpen(c.id), `round ${round}`).toBe(0);
        }
        // and every outcome is a clean one — a success, or a named refusal
        for (const r of results) {
          if (r.status === "rejected") {
            expect(["cycle_completed", "concurrent_mutation", "cycle_not_active"], `round ${round}: ${r.reason}`).toContain(
              (r.reason as Error).message,
            );
          }
        }
      }
    });

    it("an item FINISHED while the cycle completes aborts the completion (SERIALIZABLE) instead of being moved with a false audit row", async () => {
      // Deterministic, not a race to hope for: hold a transaction that has
      // finished `racer` but not committed, start completing the cycle, wait
      // until completeCycle is genuinely blocked on that row, THEN commit.
      //
      // completeCycle has by then READ `racer` as unfinished. Under READ
      // COMMITTED its UPDATE would re-evaluate against the committed row, skip
      // it, and still write a `cycle_removed` row and a carriedOverCount that
      // claim it moved. Under SERIALIZABLE the UPDATE hits a concurrent change
      // to a row of its snapshot and the whole completion aborts, applying
      // nothing — which is the behaviour the service documents and answers 409.
      const s = await sprint();
      const racer = await item(projectA, { name: "racer", cycleId: s.c.id });

      let release!: () => void;
      const hold = new Promise<void>((r) => (release = r));
      let finished!: () => void;
      const finishedApplied = new Promise<void>((r) => (finished = r));
      const finisher = prisma.$transaction(
        async (tx) => {
          await tx.pmWorkItem.update({
            where: { id: racer.id },
            data: { isCompleted: true, completedAt: new Date(), stateId: statesA.done },
          });
          finished();
          await hold;
        },
        { maxWait: 10_000, timeout: 60_000 },
      );
      await finishedApplied;

      const completion = cycles.completeCycle(prisma, "u1", s.c.id, { moveIncompleteTo: null });
      completion.catch(() => undefined); // judged below; keep it from being 'unhandled' while we wait

      const blocked = async () => {
        const rows = await prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%PmWorkItem%'`;
        return rows[0].n > 0;
      };
      for (let i = 0; i < 400 && !(await blocked()); i += 1) await new Promise((r) => setTimeout(r, 25));
      expect(await blocked(), "completeCycle should be waiting on the finisher's row lock").toBe(true);

      release();
      const [, result] = await Promise.allSettled([finisher, completion]);

      expect(result.status).toBe("rejected");
      expect((result as PromiseRejectedResult).reason.message).toBe("concurrent_mutation");
      // nothing was applied
      expect((await prisma.pmCycle.findUnique({ where: { id: s.c.id } }))!.status).toBe("active");
      expect(await prisma.pmActivity.count({ where: { verb: "cycle_removed", oldValue: s.c.id } })).toBe(0);
      expect((await prisma.pmWorkItem.findUnique({ where: { id: s.todo.id } }))!.cycleId).toBe(s.c.id);
      // and a retry sees the world as it now is: racer is finished, so it stays
      const retry = await cycles.completeCycle(prisma, "u1", s.c.id, { moveIncompleteTo: null });
      expect(retry.moved.count).toBe(3);
      expect((await prisma.pmWorkItem.findUnique({ where: { id: racer.id } }))!.cycleId).toBe(s.c.id);
    });

    it("a completed cycle refuses new work from the work-item path, but lets work out", async () => {
      const s = await sprint();
      await cycles.completeCycle(prisma, "u1", s.c.id, { moveIncompleteTo: null });
      await expect(pm.updateWorkItem(prisma, "u1", s.bystander.id, { cycleId: s.c.id })).rejects.toThrow("cycle_completed");
      await expect(pm.createWorkItem(prisma, "u1", projectA, { name: "warp3521-new", cycleId: s.c.id })).rejects.toThrow("cycle_completed");
      await expect(pm.updateWorkItem(prisma, "u1", s.done.id, { cycleId: null })).resolves.toBeTruthy();
    });
  });

  // ═══ planning an item, through the work-item service ═════════════════════════

  describe("planning work items into cycles (pm.service)", () => {
    it("attach, move and detach write the rows the burndown reads", async () => {
      const a = await cycle(projectA, { name: "a", status: "active" });
      const b = await cycle(projectA, { name: "b" });
      const it = await item(projectA);

      await pm.updateWorkItem(prisma, "u1", it.id, { cycleId: a.id });
      await pm.updateWorkItem(prisma, "u1", it.id, { cycleId: b.id });
      await pm.updateWorkItem(prisma, "u1", it.id, { cycleId: null });
      // an identity update writes nothing
      await pm.updateWorkItem(prisma, "u1", it.id, { cycleId: null });

      const rows = await prisma.pmActivity.findMany({
        where: { workItemId: it.id, verb: { in: ["cycle_added", "cycle_removed"] } },
        orderBy: { createdAt: "asc" },
      });
      expect(rows.map((r) => [r.verb, r.oldValue, r.newValue])).toEqual([
        ["cycle_added", null, a.id],
        ["cycle_added", a.id, b.id],
        ["cycle_removed", b.id, null],
      ]);
    });

    it("serializes overlapping cycle moves so each audit row starts at the value it actually replaced", async () => {
      const a = await cycle(projectA, { name: "cas-a", status: "active" });
      const b = await cycle(projectA, { name: "cas-b" });
      const c = await cycle(projectA, { name: "cas-c" });
      const it = await item(projectA, { name: "cas-item", cycleId: a.id });

      let release!: () => void;
      const hold = new Promise<void>((resolve) => (release = resolve));
      let movedToB!: () => void;
      const bApplied = new Promise<void>((resolve) => (movedToB = resolve));
      const firstMove = prisma.$transaction(async (tx) => {
        await tx.pmWorkItem.update({ where: { id: it.id }, data: { cycleId: b.id } });
        await tx.pmActivity.create({
          data: {
            workItemId: it.id,
            actorId: "u1",
            verb: "cycle_added",
            field: "cycle",
            oldValue: a.id,
            newValue: b.id,
          },
        });
        movedToB();
        await hold;
      }, { maxWait: 10_000, timeout: 60_000 });
      await bApplied;

      // The service has read A and is waiting on the row locked by firstMove.
      // Commit B while it waits; its compare-and-set must then observe B and
      // retry from there instead of recording the stale A -> C transition.
      const secondMove = pm.updateWorkItem(prisma, "u2", it.id, { cycleId: c.id });
      secondMove.catch(() => undefined);
      const blocked = async () => {
        const rows = await prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query ILIKE '%UPDATE%PmWorkItem%'
        `;
        return rows[0].n > 0;
      };
      for (let i = 0; i < 400 && !(await blocked()); i += 1) await new Promise((r) => setTimeout(r, 25));
      expect(await blocked(), "the second cycle move should wait on the item's row lock").toBe(true);

      release();
      await firstMove;
      await expect(secondMove).resolves.toBeTruthy();

      expect((await prisma.pmWorkItem.findUnique({ where: { id: it.id } }))!.cycleId).toBe(c.id);
      const rows = await prisma.pmActivity.findMany({
        where: { workItemId: it.id, verb: "cycle_added" },
        orderBy: { createdAt: "asc" },
      });
      expect(rows.map((row) => [row.oldValue, row.newValue])).toEqual([
        [a.id, b.id],
        [b.id, c.id],
      ]);
    });

    it("refuses another project's cycle with invalid_cycle — the service says it before the trigger has to", async () => {
      const foreign = await cycle(projectB, { name: "foreign" });
      const it = await item(projectA);
      await expect(pm.updateWorkItem(prisma, "u1", it.id, { cycleId: foreign.id })).rejects.toThrow("invalid_cycle");
      await expect(pm.createWorkItem(prisma, "u1", projectA, { name: "warp3521-x", cycleId: foreign.id })).rejects.toThrow("invalid_cycle");
    });

    it("a refused create leaves no item and burns no sequence number", async () => {
      const foreign = await cycle(projectB, { name: "foreign" });
      const before = (await prisma.pmProject.findUnique({ where: { id: projectA } }))!.seqCounter;
      await expect(pm.createWorkItem(prisma, "u1", projectA, { name: "warp3521-x", cycleId: foreign.id })).rejects.toThrow();
      expect(await prisma.pmWorkItem.count({ where: { name: "warp3521-x" } })).toBe(0);
      expect((await prisma.pmProject.findUnique({ where: { id: projectA } }))!.seqCounter).toBe(before);
    });
  });

  // ═══ delete ══════════════════════════════════════════════════════════════════

  describe("deleteCycle / deleteModule audit what the database detaches silently", () => {
    it("deleteCycle: a cycle_removed row per attached item, then the items are in the backlog", async () => {
      const c = await cycle(projectA, { name: "doomed", status: "active" });
      const a = await item(projectA, { cycleId: c.id });
      const b = await item(projectA, { cycleId: c.id, stateId: statesA.done, isCompleted: true });
      await cycles.deleteCycle(prisma, "u1", c.id);
      expect(await prisma.pmCycle.findUnique({ where: { id: c.id } })).toBeNull();
      expect((await prisma.pmWorkItem.findUnique({ where: { id: a.id } }))!.cycleId).toBeNull();
      const rows = await prisma.pmActivity.findMany({ where: { verb: "cycle_removed", oldValue: c.id } });
      expect(rows.map((r) => r.workItemId).sort()).toEqual([a.id, b.id].sort());
    });

    it("deleteModule: a module_removed row per member, items untouched", async () => {
      const m = await moduleRow(projectA);
      const a = await item(projectA);
      await modules.addModuleWorkItems(prisma, "u1", m.id, [a.id]);
      await modules.deleteModule(prisma, "u1", m.id);
      expect(await prisma.pmWorkItem.findUnique({ where: { id: a.id } })).not.toBeNull();
      const rows = await prisma.pmActivity.findMany({ where: { workItemId: a.id, verb: "module_removed" } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ oldValue: m.id, newValue: null, actorId: "u1" });
    });
  });

  // ═══ modules ═════════════════════════════════════════════════════════════════

  describe("modules against a real database", () => {
    it("add is idempotent and audits only new links; remove audits only real ones; progress follows", async () => {
      const m = await moduleRow(projectA);
      const done = await item(projectA, { name: "d", stateId: statesA.done, isCompleted: true, estimate: 5 });
      const open = await item(projectA, { name: "o", estimate: 3 });

      const first = await modules.addModuleWorkItems(prisma, "u1", m.id, [done.id, open.id]);
      expect(first.added).toBe(2);
      expect(first.module.progress).toMatchObject({ total: 2, completed: 1, totalEstimate: 8, completedEstimate: 5 });

      const again = await modules.addModuleWorkItems(prisma, "u1", m.id, [done.id, open.id]);
      expect(again.added).toBe(0);
      expect(await prisma.pmActivity.count({ where: { verb: "module_added", newValue: m.id } })).toBe(2);

      const out = await modules.removeModuleWorkItems(prisma, "u1", m.id, [open.id, "never-linked"]);
      expect(out.removed).toBe(1);
      expect(out.module.progress.total).toBe(1);
      expect(await prisma.pmActivity.count({ where: { verb: "module_removed", oldValue: m.id } })).toBe(1);
    });

    it("refuses an item of another project with invalid_work_item, linking nothing", async () => {
      const m = await moduleRow(projectA);
      const mine = await item(projectA);
      const other = await prisma.pmWorkItem.create({ data: { projectId: projectB, sequenceId: ++seq, name: "warp3521-foreign" } });
      await expect(modules.addModuleWorkItems(prisma, "u1", m.id, [mine.id, other.id])).rejects.toThrow("invalid_work_item");
      expect(await prisma.pmModuleWorkItem.count({ where: { moduleId: m.id } })).toBe(0);
    });

    it("two overlapping adds of the same item leave one link and not a unique-violation 500", async () => {
      const m = await moduleRow(projectA);
      const it = await item(projectA);
      const results = await Promise.allSettled([
        modules.addModuleWorkItems(prisma, "u1", m.id, [it.id]),
        modules.addModuleWorkItems(prisma, "u2", m.id, [it.id]),
      ]);
      expect(await prisma.pmModuleWorkItem.count({ where: { moduleId: m.id } })).toBe(1);
      for (const r of results) {
        if (r.status === "rejected") expect((r.reason as Error).message).toBe("concurrent_mutation");
      }
    });

    it("listWorkItemsWhere scopes a module's items and reports the exact total", async () => {
      const m = await moduleRow(projectA);
      const a = await item(projectA, { name: "a" });
      await item(projectA, { name: "b" });
      await modules.addModuleWorkItems(prisma, "u1", m.id, [a.id]);
      const out = await modules.listModuleWorkItems(prisma, m.id, {});
      expect(out.total).toBe(1);
      expect(out.work_items.map((w) => w.id)).toEqual([a.id]);
    });

    it("listModulesForWorkItem answers the item's own modules", async () => {
      const m1 = await moduleRow(projectA, { name: "alpha" });
      await moduleRow(projectA, { name: "beta" });
      const it = await item(projectA);
      await modules.addModuleWorkItems(prisma, "u1", m1.id, [it.id]);
      expect(await modules.listModulesForWorkItem(prisma, it.id)).toEqual([
        { id: m1.id, name: "warp3521-alpha", status: "backlog" },
      ]);
    });
  });

  // ═══ the lists the planning views read ═══════════════════════════════════════

  describe("the cycle and backlog readers", () => {
    it("the backlog is unfinished, unarchived work in no cycle; a cycle's list is its own, with the exact total", async () => {
      const c = await cycle(projectA, { name: "c", status: "active" });
      const inCycle = await item(projectA, { name: "in", cycleId: c.id });
      const open = await item(projectA, { name: "open" });
      await item(projectA, { name: "finished", stateId: statesA.done, isCompleted: true });
      await item(projectA, { name: "hidden", isArchived: true });

      const backlog = await cycles.listBacklog(prisma, projectA, {});
      expect(backlog.work_items.map((w) => w.id)).toEqual([open.id]);
      expect(backlog.total).toBe(1);

      const mine = await cycles.listCycleWorkItems(prisma, c.id, { perPage: 1 });
      expect(mine.work_items.map((w) => w.id)).toEqual([inCycle.id]);
      expect(mine.total).toBe(1);
    });

    it("progress counts only live items, split by state group, with estimates", async () => {
      const c = await cycle(projectA, { name: "c", status: "active" });
      await item(projectA, { cycleId: c.id, stateId: statesA.done, isCompleted: true, estimate: 5 });
      await item(projectA, { cycleId: c.id, stateId: statesA.cancelled, isCompleted: true, estimate: 2 });
      await item(projectA, { cycleId: c.id, stateId: statesA.doing, estimate: 3 });
      await item(projectA, { cycleId: c.id, estimate: 100, isArchived: true });
      expect((await cycles.getCycle(prisma, c.id)).progress).toEqual({
        total: 3,
        completed: 1,
        cancelled: 1,
        totalEstimate: 10,
        completedEstimate: 5,
        cancelledEstimate: 2,
      });
    });
  });

  // ═══ 4. the burndown ═════════════════════════════════════════════════════════

  describe("burndown", () => {
    it("rebuilds the week from the activity feed — scope that rises and falls, work that is reopened, an item carried in", async () => {
      const prior = await cycle(projectA, { name: "prior", status: "completed", startDate: d("2026-09-21"), endDate: d("2026-10-02") });
      const c = await cycle(projectA, { name: "week", status: "active", startDate: d("2026-10-05"), endDate: d("2026-10-09") });
      const other = await cycle(projectA, { name: "other", status: "completed", startDate: d("2026-08-03"), endDate: d("2026-08-14") });

      // live rows — the truth NOW (Thursday 10:00)
      const A = await item(projectA, { name: "A", cycleId: c.id, stateId: statesA.done, isCompleted: true, estimate: 5 });
      const B = await item(projectA, { name: "B", cycleId: c.id, estimate: 3 });
      const C = await item(projectA, { name: "C", cycleId: c.id, estimate: 2 });
      const D = await item(projectA, { name: "D", cycleId: null, estimate: 1 }); // left Thursday
      const E = await item(projectA, { name: "E", cycleId: c.id, estimate: 4 });
      const F = await item(projectA, { name: "F", cycleId: c.id, stateId: statesA.doing, estimate: 2 });
      const noise = await item(projectA, { name: "noise", cycleId: other.id });

      const at = (iso: string) => new Date(iso);
      const act = (
        workItemId: string,
        verb: "cycle_added" | "cycle_removed" | "state_changed" | "commented" | "updated",
        iso: string,
        oldValue: string | null = null,
        newValue: string | null = null,
        field: string | null = verb === "state_changed" ? "state" : verb.startsWith("cycle") ? "cycle" : null,
      ) => prisma.pmActivity.create({ data: { workItemId, verb, field, oldValue, newValue, createdAt: at(iso) } });

      await act(A.id, "cycle_added", "2026-10-05T09:00:00Z", null, c.id);
      await act(A.id, "state_changed", "2026-10-06T15:00:00Z", statesA.doing, statesA.done);
      await act(B.id, "cycle_added", "2026-10-05T09:00:00Z", null, c.id);
      await act(B.id, "state_changed", "2026-10-06T12:00:00Z", statesA.todo, statesA.doing); // open → open: no effect
      await act(B.id, "commented", "2026-10-06T13:00:00Z");
      await act(C.id, "cycle_added", "2026-10-07T11:00:00Z", null, c.id); // scope creep, Wednesday
      await act(D.id, "cycle_added", "2026-10-05T09:00:00Z", null, c.id);
      await act(D.id, "cycle_removed", "2026-10-08T08:00:00Z", c.id, null); // pulled out Thursday
      await act(E.id, "cycle_added", "2026-10-05T09:30:00Z", prior.id, c.id); // carried in: ONE row, prior → c
      await act(F.id, "cycle_added", "2026-10-05T09:00:00Z", null, c.id);
      await act(F.id, "state_changed", "2026-10-06T10:00:00Z", statesA.doing, statesA.done);
      await act(F.id, "state_changed", "2026-10-08T05:00:00Z", statesA.done, statesA.doing); // reopened Thursday
      await act(noise.id, "cycle_added", "2026-10-05T09:00:00Z", null, other.id);

      const out = await cycles.getCycleBurndown(prisma, c.id, { now: new Date("2026-10-08T10:00:00Z") });

      expect(out.startDate).toBe("2026-10-05");
      expect(out.endDate).toBe("2026-10-09");
      expect(out.through).toBe("2026-10-08");
      expect(out.hasEstimates).toBe(true);
      const col = (k: keyof (typeof out.days)[number]) => out.days.map((p) => p[k]);
      expect(col("date")).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);
      //                          Mon   Tue   Wed   Thu   Fri (future)
      expect(col("scope")).toEqual([5, 5, 6, 5, null]);
      expect(col("remaining")).toEqual([5, 3, 4, 4, null]);
      expect(col("completed")).toEqual([0, 2, 2, 1, null]);
      expect(col("added")).toEqual([5, 0, 1, 0, null]);
      expect(col("removed")).toEqual([0, 0, 0, 1, null]);
      expect(col("scopeEstimate")).toEqual([15, 15, 17, 16, null]);
      expect(col("remainingEstimate")).toEqual([15, 8, 10, 11, null]);
      expect(col("ideal")).toEqual([5, 3.75, 2.5, 1.25, 0]);
      expect(col("idealEstimate")).toEqual([15, 11.25, 7.5, 3.75, 0]);

      // The last point is the live truth: 5 members, one of them (A) done.
      const live = await cycles.getCycle(prisma, c.id);
      expect(live.progress.total).toBe(out.days[3].scope);
      expect(live.progress.completed).toBe(out.days[3].completed);
    });

    it("CONTRACT: what the services write is what the burndown reads", async () => {
      const c = await cycle(projectA, {
        name: "contract",
        status: "active",
        startDate: d(formatDateOnly(new Date(Date.now() - 3 * 86_400_000))!),
        endDate: d(formatDateOnly(new Date(Date.now() + 3 * 86_400_000))!),
      });

      const x1 = await pm.createWorkItem(prisma, "u1", projectA, { name: "warp3521-x1", cycleId: c.id }); // planned at birth
      const x2 = await pm.createWorkItem(prisma, "u1", projectA, { name: "warp3521-x2" });
      await pm.updateWorkItem(prisma, "u1", x2.id, { cycleId: c.id }); // attached later
      const x3 = await pm.createWorkItem(prisma, "u1", projectA, { name: "warp3521-x3" });
      await pm.updateWorkItem(prisma, "u1", x3.id, { cycleId: c.id });
      await pm.updateWorkItem(prisma, "u1", x3.id, { cycleId: null }); // and detached again
      await pm.transitionWorkItem(prisma, "u1", x1.id, statesA.done); // x1 finished

      const out = await cycles.getCycleBurndown(prisma, c.id);
      const lastEvent = await prisma.pmActivity.findFirst({ where: { workItemId: x1.id }, orderBy: { createdAt: "desc" } });
      const today = out.days.find((p) => p.date === formatDateOnly(lastEvent!.createdAt));
      expect(today, "the day the events happened must be on the chart").toBeDefined();
      expect(today).toMatchObject({ scope: 2, completed: 1, remaining: 1, added: 3, removed: 1 });
      // and the day before saw none of it
      const yesterday = out.days[out.days.indexOf(today!) - 1];
      expect(yesterday).toMatchObject({ scope: 0, remaining: 0 });
      // the chart's last actual day agrees with the progress card
      const live = await cycles.getCycle(prisma, c.id);
      const last = out.days.find((p) => p.date === out.through)!;
      expect(last.scope).toBe(live.progress.total);
      expect(last.completed).toBe(live.progress.completed);
    });

    it("a cycle completed early is charted only up to the day it was completed", async () => {
      const c = await cycle(projectA, {
        name: "early",
        status: "active",
        startDate: d("2026-10-05"),
        endDate: d("2026-10-16"),
      });
      await item(projectA, { cycleId: c.id, stateId: statesA.done, isCompleted: true });
      await cycles.completeCycle(prisma, "u1", c.id, { moveIncompleteTo: null });
      // completeCycle stamps the real clock; pretend the sprint ended on its second day
      await prisma.pmCycle.update({ where: { id: c.id }, data: { completedAt: new Date("2026-10-06T18:00:00Z") } });
      const out = await cycles.getCycleBurndown(prisma, c.id, { now: new Date("2026-11-01T00:00:00Z") });
      expect(out.days.map((p) => p.date)).toEqual(["2026-10-05", "2026-10-06"]);
    });

    it("an undated cycle has no chart", async () => {
      const c = await cycle(projectA, { name: "undated", startDate: null, endDate: null });
      const out = await cycles.getCycleBurndown(prisma, c.id);
      expect(out.days).toEqual([]);
    });
  });

  // ═══ the dates survive a round trip untouched ════════════════════════════════

  describe("calendar dates", () => {
    it("a date entered is the date stored and the date answered, whatever the box's timezone", async () => {
      const created = await cycles.createCycle(prisma, projectA, {
        name: "warp3521-dates",
        startDate: parseDateOnly("2026-03-08"), // a DST-change day in the US
        endDate: parseDateOnly("2026-03-22"),
      });
      expect(created.startDate).toBe("2026-03-08");
      expect(created.endDate).toBe("2026-03-22");
      const raw = await prisma.$queryRaw<Array<{ s: string }>>`SELECT to_char("startDate", 'YYYY-MM-DD"T"HH24:MI:SS') AS s FROM "PmCycle" WHERE id = ${created.id}`;
      expect(raw[0].s).toBe("2026-03-08T00:00:00"); // midnight, no zone arithmetic in the column
    });
  });
});
