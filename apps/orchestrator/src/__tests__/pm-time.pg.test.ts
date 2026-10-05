/**
 * WARP-3526 (ADR-069 WS-10) — the invariants of time tracking that only a real
 * database can prove.
 *
 * What a mocked Prisma cannot tell us, and this file does:
 *
 *   * `PmWorklog_minutes_range` is a CHECK that lives only in migration SQL.
 *   * "one running timer per person" is a PRIMARY KEY, and "starting a second
 *     timer stops the first" is a read-then-write that two simultaneous requests
 *     from one person would race. The advisory lock in `startTimer` is what
 *     turns a double click into one timer and a switch into one worklog; a stub
 *     has no second connection to race against.
 *   * a timer, like a worklog, must not outlive its work item or its project —
 *     that is the FK cascade, not service code.
 *   * the report's totals equal the sum of the worklogs. Summed a page at a time
 *     by a keyset on `id`, so a page boundary that repeated or skipped a row
 *     would show up here as a total that is not the SUM.
 *
 * Gated like the other *.pg.test.ts files: RUN_PG_INTEGRATION=1 + DATABASE_URL.
 * Every fixture is namespaced `warp3526-` — the pg suites share one throwaway
 * database, so an unscoped deleteMany() would eat another suite's rows.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

// The global unit setup mocks @prisma/client so the DB-less lane never needs
// Postgres. This file must talk to a REAL one.
vi.unmock("@prisma/client");

import {
  createWorklog,
  deleteWorklog,
  getTimer,
  getTimeReport,
  getTimesheet,
  listWorklogs,
  startTimer,
  stopTimer,
  updateWorklog,
  type TimeActor,
} from "../services/pm/pm-time.service.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const OURS = { startsWith: "warp3526-" } as const;
const MIN = 60_000;
const at = (iso: string): Date => new Date(iso);
/** A fixed "now" for entries with a fixed start, so no test depends on the box's clock. */
const NOW = at("2026-10-05T00:00:00.000Z");

describe.skipIf(!RUN)("PM time tracking — the database's own guarantees (WARP-3526)", () => {
  let prisma: PrismaClient;
  let workspaceId = "";
  let projectA = "";
  let projectB = "";
  let seq = 0;

  const ana: TimeActor = { id: "warp3526-ana", canManageAll: false };
  const ben: TimeActor = { id: "warp3526-ben", canManageAll: false };
  const boss: TimeActor = { id: "warp3526-boss", canManageAll: true };

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>(
      "@prisma/client",
    );
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  async function wipe(): Promise<void> {
    // Worklogs and timers carry a plain user id, not an FK, so they are scoped
    // by it; items, projects and workspaces cascade the rest.
    await prisma.pmWorklog.deleteMany({ where: { userId: OURS } });
    await prisma.pmTimer.deleteMany({ where: { userId: OURS } });
    await prisma.pmProject.deleteMany({ where: { name: OURS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    await prisma.user.deleteMany({ where: { username: OURS } });
  }

  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await wipe();
    const ws = await prisma.pmWorkspace.create({
      data: { slug: `warp3526-ws-${Date.now()}`, name: "warp3526-ws" },
    });
    workspaceId = ws.id;
    projectA = (
      await prisma.pmProject.create({
        data: { workspaceId, name: "warp3526-alpha", identifier: "W35A" },
      })
    ).id;
    projectB = (
      await prisma.pmProject.create({
        data: { workspaceId, name: "warp3526-bravo", identifier: "W35B" },
      })
    ).id;
    seq = 0;
  });

  const item = (projectId = projectA, name = "item") =>
    prisma.pmWorkItem.create({
      data: { projectId, sequenceId: ++seq, name: `warp3526-${name}` },
    });

  /** SUM(minutes) straight from the table, over the work of OUR projects only —
   *  scoped by project, not by person, because the directory users a test creates
   *  have uuid ids. */
  const sumMinutes = async (): Promise<number> =>
    (
      await prisma.pmWorklog.aggregate({
        where: { workItem: { project: { name: OURS } } },
        _sum: { minutes: true },
      })
    )._sum.minutes ?? 0;

  // ── the CHECK ────────────────────────────────────────────────────────────

  describe("PmWorklog_minutes_range", () => {
    it("accepts one minute and one day, and refuses 0, a negative and a day and a minute", async () => {
      const wi = await item();
      const row = (minutes: number) =>
        prisma.pmWorklog.create({
          data: { workItemId: wi.id, userId: ana.id, startedAt: new Date(), minutes },
        });

      await expect(row(1)).resolves.toBeTruthy();
      await expect(row(1440)).resolves.toBeTruthy();
      for (const bad of [0, -1, 1441, 100000]) {
        await expect(row(bad), `minutes=${bad}`).rejects.toThrow();
      }
      expect(await prisma.pmWorklog.count({ where: { workItemId: wi.id } })).toBe(2);
    });

    it("also refuses a bad UPDATE, not only a bad insert", async () => {
      const wi = await item();
      const w = await prisma.pmWorklog.create({
        data: { workItemId: wi.id, userId: ana.id, startedAt: new Date(), minutes: 30 },
      });
      await expect(prisma.pmWorklog.update({ where: { id: w.id }, data: { minutes: 0 } })).rejects.toThrow();
      await expect(prisma.pmWorklog.update({ where: { id: w.id }, data: { minutes: 1441 } })).rejects.toThrow();
    });
  });

  describe("service-desk boundary", () => {
    it("excludes tickets from direct worklog, timer, timesheet and report paths", async () => {
      const desk = await prisma.pmProject.create({
        data: {
          workspaceId,
          name: "warp3526-service-desk",
          identifier: "W36D",
          kind: "SERVICE_DESK",
        },
      });
      const ticket = await item(desk.id, "ticket");
      await prisma.pmTicket.create({
        data: {
          workItemId: ticket.id,
          requesterKind: "USER",
          requesterUserId: ana.id,
          requesterName: "Ana",
          channel: "INTERNAL",
        },
      });
      const projectItem = await item(projectA, "project-work");
      const pmWorklog = await createWorklog(prisma, ana, projectItem.id, { minutes: 37 }, NOW);
      const deskWorklog = await prisma.pmWorklog.create({
        data: { workItemId: ticket.id, userId: ana.id, startedAt: NOW, minutes: 91 },
      });

      await expect(listWorklogs(prisma, ticket.id)).rejects.toThrow("work_item_not_found");
      await expect(updateWorklog(prisma, ana, deskWorklog.id, { note: "changed" })).rejects.toThrow(
        "worklog_not_found",
      );
      await expect(deleteWorklog(prisma, ana, deskWorklog.id)).rejects.toThrow("worklog_not_found");
      expect(await prisma.pmWorklog.findUniqueOrThrow({ where: { id: deskWorklog.id } })).toMatchObject({
        minutes: 91,
        note: "",
      });

      await prisma.pmTimer.create({ data: { userId: ana.id, workItemId: ticket.id, startedAt: NOW } });
      expect(await getTimer(prisma, ana.id)).toBeNull();
      await expect(stopTimer(prisma, ana.id, NOW)).rejects.toThrow("timer_not_found");
      await expect(startTimer(prisma, ana.id, projectItem.id, NOW)).rejects.toThrow("timer_not_found");
      expect(await prisma.pmTimer.findUniqueOrThrow({ where: { userId: ana.id } })).toMatchObject({
        workItemId: ticket.id,
      });

      const sheet = await getTimesheet(prisma, { userId: ana.id, weekStart: "2026-10-05" }, NOW);
      expect(sheet.totalMinutes).toBe(37);
      expect(sheet.rows.map((r) => r.workItem.id)).toEqual([projectItem.id]);
      const report = await getTimeReport(prisma, { from: "2026-10-05", to: "2026-10-05", groupBy: "item" });
      expect(report.total).toEqual({ minutes: 37, entries: 1 });
      expect(report.rows.map((r) => r.key)).toEqual([projectItem.id]);
      await expect(
        getTimeReport(prisma, { projectId: desk.id, from: "2026-10-05", to: "2026-10-05" }),
      ).rejects.toThrow("project_not_found");

      // Ensure a real PM worklog remains visible after each rejected ticket path.
      await expect(updateWorklog(prisma, ana, pmWorklog.id, { note: "still PM" })).resolves.toMatchObject({
        workItemId: projectItem.id,
        note: "still PM",
      });
    });
  });

  // ── one timer per person: the primary key ────────────────────────────────

  describe("PmTimer — one running timer per person is the primary key's rule", () => {
    it("refuses a second timer for the same person even when a writer bypasses the service", async () => {
      const a = await item(projectA, "a");
      const b = await item(projectA, "b");
      await prisma.pmTimer.create({ data: { userId: ana.id, workItemId: a.id } });
      await expect(prisma.pmTimer.create({ data: { userId: ana.id, workItemId: b.id } })).rejects.toMatchObject({
        code: "P2002",
      });
      // …and another person's timer on the same item is fine.
      await expect(prisma.pmTimer.create({ data: { userId: ben.id, workItemId: a.id } })).resolves.toBeTruthy();
    });
  });

  // ── no orphans: the cascade ──────────────────────────────────────────────

  describe("a timer and its worklogs never outlive their work item", () => {
    it("deleting the work item removes its timers and its worklogs", async () => {
      const gone = await item(projectA, "gone");
      const kept = await item(projectA, "kept");
      await startTimer(prisma, ana.id, gone.id);
      await startTimer(prisma, ben.id, kept.id);
      await createWorklog(prisma, ana, gone.id, { minutes: 10 });
      await createWorklog(prisma, ana, kept.id, { minutes: 20 });

      await prisma.pmWorkItem.delete({ where: { id: gone.id } });

      expect(await getTimer(prisma, ana.id)).toBeNull();
      expect(await prisma.pmTimer.count({ where: { workItemId: gone.id } })).toBe(0);
      expect(await prisma.pmWorklog.count({ where: { workItemId: gone.id } })).toBe(0);
      // Nothing else was touched.
      expect((await getTimer(prisma, ben.id))?.workItemId).toBe(kept.id);
      expect(await prisma.pmWorklog.count({ where: { workItemId: kept.id } })).toBe(1);
    });

    it("deleting the project removes the timers and worklogs of every item in it", async () => {
      const a = await item(projectB, "in-b-1");
      const b = await item(projectB, "in-b-2");
      await startTimer(prisma, ana.id, a.id);
      await createWorklog(prisma, ben, b.id, { minutes: 15 });

      await prisma.pmProject.delete({ where: { id: projectB } });

      expect(await getTimer(prisma, ana.id)).toBeNull();
      expect(await prisma.pmWorklog.count({ where: { workItemId: { in: [a.id, b.id] } } })).toBe(0);
    });

    it("ARCHIVING is not deleting: a timer on archived work stays readable and stoppable, and cannot be started anew", async () => {
      const a = await item(projectA, "to-archive");
      const b = await item(projectA, "other");
      await startTimer(prisma, ana.id, a.id, at("2026-10-04T09:00:00.000Z"));
      await prisma.pmWorkItem.update({ where: { id: a.id }, data: { isArchived: true } });

      const running = await getTimer(prisma, ana.id);
      expect(running?.workItem).toMatchObject({ id: a.id, archived: true });

      // A new timer on archived work is refused, and refusing it leaves the
      // running one alone — nothing is stopped for a start that did not happen.
      await expect(startTimer(prisma, ben.id, a.id)).rejects.toThrow("work_item_archived");
      await prisma.pmWorkItem.update({ where: { id: b.id }, data: { isArchived: true } });
      await expect(startTimer(prisma, ana.id, b.id)).rejects.toThrow("work_item_archived");
      expect((await getTimer(prisma, ana.id))?.workItemId).toBe(a.id);
      expect(await prisma.pmWorklog.count({ where: { userId: ana.id } })).toBe(0);

      // The time was really spent, so it can still be stopped and logged.
      const stopped = await stopTimer(prisma, ana.id, at("2026-10-04T09:25:00.000Z"));
      expect(stopped.worklog).toMatchObject({ workItemId: a.id, minutes: 25 });
      expect(await getTimer(prisma, ana.id)).toBeNull();
    });

    it("an item in an ARCHIVED PROJECT refuses new time the same way", async () => {
      const a = await item(projectA, "in-archived-project");
      await prisma.pmProject.update({ where: { id: projectA }, data: { isArchived: true } });
      await expect(startTimer(prisma, ana.id, a.id)).rejects.toThrow("work_item_archived");
      await expect(createWorklog(prisma, ana, a.id, { minutes: 5 })).rejects.toThrow("work_item_archived");
    });
  });

  // ── start / stop ─────────────────────────────────────────────────────────

  describe("startTimer / stopTimer", () => {
    it("starting a second timer stops the first and writes exactly ONE worklog", async () => {
      const a = await item(projectA, "first");
      const b = await item(projectA, "second");
      const t0 = at("2026-10-04T09:00:00.000Z");

      const first = await startTimer(prisma, ana.id, a.id, t0);
      expect(first.stopped).toBeNull();
      expect(first.timer).toMatchObject({ workItemId: a.id, startedAt: t0.toISOString() });

      const second = await startTimer(prisma, ana.id, b.id, new Date(t0.getTime() + 47 * MIN + 20_000));
      expect(second.timer.workItemId).toBe(b.id);
      expect(second.stopped).toMatchObject({
        workItemId: a.id,
        userId: ana.id,
        startedAt: t0.toISOString(),
        minutes: 47,
      });

      const logs = await prisma.pmWorklog.findMany({ where: { userId: ana.id } });
      expect(logs).toHaveLength(1);
      expect(await prisma.pmTimer.count({ where: { userId: ana.id } })).toBe(1);
      expect((await getTimer(prisma, ana.id))?.workItemId).toBe(b.id);
    });

    it("starting the item that is already running changes nothing and writes nothing", async () => {
      const a = await item();
      const t0 = at("2026-10-04T09:00:00.000Z");
      await startTimer(prisma, ana.id, a.id, t0);
      const again = await startTimer(prisma, ana.id, a.id, new Date(t0.getTime() + 10 * MIN));
      expect(again.stopped).toBeNull();
      expect(again.timer.startedAt).toBe(t0.toISOString());
      expect(await prisma.pmWorklog.count({ where: { userId: ana.id } })).toBe(0);
      expect(await prisma.pmActivity.count({ where: { workItemId: a.id } })).toBe(0);
    });

    it("a start for an item that does not exist is a 404-shaped error and stops nothing", async () => {
      const a = await item();
      await startTimer(prisma, ana.id, a.id);
      await expect(startTimer(prisma, ana.id, "warp3526-no-such-item")).rejects.toThrow("work_item_not_found");
      expect((await getTimer(prisma, ana.id))?.workItemId).toBe(a.id);
      expect(await prisma.pmWorklog.count({ where: { userId: ana.id } })).toBe(0);
    });

    it("stopping logs the elapsed minutes from the timer's own start, records time_logged, and clears the timer", async () => {
      const a = await item();
      const t0 = at("2026-10-04T09:00:00.000Z");
      await startTimer(prisma, ana.id, a.id, t0);

      const { worklog, capped } = await stopTimer(prisma, ana.id, new Date(t0.getTime() + 90 * MIN));
      expect(capped).toBe(false);
      expect(worklog).toMatchObject({
        workItemId: a.id,
        userId: ana.id,
        startedAt: t0.toISOString(),
        minutes: 90,
        note: "",
      });
      expect(await getTimer(prisma, ana.id)).toBeNull();

      const acts = await prisma.pmActivity.findMany({ where: { workItemId: a.id } });
      expect(acts).toHaveLength(1);
      expect(acts[0]).toMatchObject({ verb: "time_logged", actorId: ana.id, field: "worklog", newValue: "90" });
    });

    it("stopping with no timer running is timer_not_found", async () => {
      await expect(stopTimer(prisma, ana.id)).rejects.toThrow("timer_not_found");
    });

    it("a run of under a minute still leaves a one-minute entry, and a forgotten timer is capped at a day and says so", async () => {
      const a = await item();
      const t0 = at("2026-10-04T09:00:00.000Z");
      await startTimer(prisma, ana.id, a.id, t0);
      expect((await stopTimer(prisma, ana.id, new Date(t0.getTime() + 12_000))).worklog.minutes).toBe(1);

      // A timer left running for three days (inserted directly: no clock tricks).
      await prisma.pmTimer.create({
        data: { userId: ana.id, workItemId: a.id, startedAt: new Date(t0.getTime() - 3 * 24 * 60 * MIN) },
      });
      const stopped = await stopTimer(prisma, ana.id, t0);
      expect(stopped).toMatchObject({ capped: true, worklog: { minutes: 1440 } });
    });

    it("two timers by two people on one item are independent", async () => {
      const a = await item();
      await startTimer(prisma, ana.id, a.id);
      await startTimer(prisma, ben.id, a.id);
      await stopTimer(prisma, ana.id);
      expect((await getTimer(prisma, ben.id))?.workItemId).toBe(a.id);
      expect(await prisma.pmWorklog.count({ where: { userId: ana.id } })).toBe(1);
      expect(await prisma.pmWorklog.count({ where: { userId: ben.id } })).toBe(0);
    });
  });

  describe("a person's simultaneous requests cannot leave two timers or lose time", () => {
    it("a burst of starts on ONE item (a double click, three tabs) leaves one timer and no worklog", async () => {
      const a = await item();
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => startTimer(prisma, ana.id, a.id)),
      );
      expect(results.filter((r) => r.status === "rejected")).toEqual([]);
      expect(await prisma.pmTimer.count({ where: { userId: ana.id } })).toBe(1);
      expect(await prisma.pmWorklog.count({ where: { userId: ana.id } })).toBe(0);
    });

    it("two starts on DIFFERENT items at once leave exactly one timer and exactly one worklog — for the other item", async () => {
      const a = await item(projectA, "race-a");
      const b = await item(projectA, "race-b");
      const t0 = at("2026-10-04T09:00:00.000Z");
      const results = await Promise.allSettled([
        startTimer(prisma, ana.id, a.id, t0),
        startTimer(prisma, ana.id, b.id, t0),
      ]);
      expect(results.filter((r) => r.status === "rejected")).toEqual([]);

      const timers = await prisma.pmTimer.findMany({ where: { userId: ana.id } });
      const logs = await prisma.pmWorklog.findMany({ where: { userId: ana.id } });
      expect(timers).toHaveLength(1);
      expect(logs).toHaveLength(1);
      expect(logs[0].workItemId).not.toBe(timers[0].workItemId);
      expect(logs[0].minutes).toBe(1);
    });

    it("a stop racing a start never double-logs: one worklog per timer, whatever the interleaving", async () => {
      const a = await item(projectA, "stop-a");
      const b = await item(projectA, "stop-b");
      await startTimer(prisma, ana.id, a.id, at("2026-10-04T09:00:00.000Z"));
      const results = await Promise.allSettled([
        stopTimer(prisma, ana.id, at("2026-10-04T09:30:00.000Z")),
        startTimer(prisma, ana.id, b.id, at("2026-10-04T09:30:00.000Z")),
      ]);
      // Either order is legal: stop-then-start (timer b, log a) or start-then-stop
      // (log a, then log b's zero-length run). The stop may find no timer only if
      // it ran after start already replaced it — which is still a timer — so
      // nothing here is allowed to fail.
      expect(results.filter((r) => r.status === "rejected")).toEqual([]);
      const logs = await prisma.pmWorklog.findMany({ where: { userId: ana.id } });
      const timers = await prisma.pmTimer.count({ where: { userId: ana.id } });
      // Each timer that existed produced at most one worklog, and a timer was
      // either stopped or is still running — never both, never neither.
      expect(logs.filter((l) => l.workItemId === a.id)).toHaveLength(1);
      expect(logs.length + timers).toBe(2);
    });
  });

  // ── worklogs ─────────────────────────────────────────────────────────────

  describe("worklog create / update / delete", () => {
    it("rejects minutes outside 1..1440 before the database sees them, with a typed error", async () => {
      const wi = await item();
      for (const bad of [0, -5, 1441, 1.5, Number.NaN]) {
        await expect(createWorklog(prisma, ana, wi.id, { minutes: bad }), String(bad)).rejects.toThrow(
          "invalid_minutes",
        );
      }
      await expect(createWorklog(prisma, ana, wi.id, { minutes: 1440 })).resolves.toMatchObject({ minutes: 1440 });
    });

    it("refuses a start in the future (a few minutes of clock skew are forgiven)", async () => {
      const wi = await item();
      const now = at("2026-10-04T12:00:00.000Z");
      await expect(
        createWorklog(prisma, ana, wi.id, { minutes: 5, startedAt: at("2026-10-04T12:04:00.000Z") }, now),
      ).resolves.toBeTruthy();
      await expect(
        createWorklog(prisma, ana, wi.id, { minutes: 5, startedAt: at("2026-10-04T12:06:00.000Z") }, now),
      ).rejects.toThrow("started_at_in_future");
    });

    it("writes the entry and a time_logged activity row in one go, attributed to whoever typed it", async () => {
      const wi = await item();
      const sam = await prisma.user.create({ data: { username: "warp3526-sam", displayName: "Sam Test" } });
      const w = await createWorklog(
        prisma,
        boss,
        wi.id,
        { minutes: 45, note: "Fixed the printer", startedAt: at("2026-10-03T14:00:00.000Z"), userId: sam.id },
        NOW,
      );
      expect(w).toMatchObject({ userId: sam.id, minutes: 45, note: "Fixed the printer" });
      const acts = await prisma.pmActivity.findMany({ where: { workItemId: wi.id } });
      expect(acts).toHaveLength(1);
      expect(acts[0]).toMatchObject({ verb: "time_logged", actorId: boss.id, newValue: "45" });
    });

    it("a member logs only their own time; an owner or admin may log for a person who exists, and only for one", async () => {
      const wi = await item();
      await expect(createWorklog(prisma, ana, wi.id, { minutes: 5, userId: ben.id })).rejects.toThrow(
        "worklog_forbidden",
      );
      await expect(createWorklog(prisma, boss, wi.id, { minutes: 5, userId: "warp3526-nobody" })).rejects.toThrow(
        "user_not_found",
      );
      const sam = await prisma.user.create({ data: { username: "warp3526-sam", displayName: "Sam Test" } });
      await expect(createWorklog(prisma, boss, wi.id, { minutes: 5, userId: sam.id })).resolves.toMatchObject({
        userId: sam.id,
      });
    });

    it("an entry is its writer's to change; an owner or admin may change anyone's", async () => {
      const wi = await item();
      const mine = await createWorklog(prisma, ana, wi.id, { minutes: 30 });

      await expect(updateWorklog(prisma, ben, mine.id, { minutes: 31 })).rejects.toThrow("worklog_forbidden");
      await expect(deleteWorklog(prisma, ben, mine.id)).rejects.toThrow("worklog_forbidden");
      expect(await prisma.pmWorklog.count({ where: { id: mine.id } })).toBe(1);

      await expect(updateWorklog(prisma, ana, mine.id, { minutes: 35, note: "reviewed" })).resolves.toMatchObject({
        minutes: 35,
        note: "reviewed",
      });
      await expect(updateWorklog(prisma, boss, mine.id, { minutes: 40 })).resolves.toMatchObject({
        userId: ana.id,
        minutes: 40,
      });
      await expect(deleteWorklog(prisma, boss, mine.id)).resolves.toBeUndefined();
      await expect(deleteWorklog(prisma, boss, mine.id)).rejects.toThrow("worklog_not_found");
      await expect(updateWorklog(prisma, boss, mine.id, { minutes: 1 })).rejects.toThrow("worklog_not_found");
    });

    it("an update writes time_log_updated with the minutes before and after; a save that changes nothing writes nothing", async () => {
      const wi = await item();
      const w = await createWorklog(prisma, ana, wi.id, { minutes: 30, note: "x" });
      await updateWorklog(prisma, ana, w.id, { minutes: 50 });
      await updateWorklog(prisma, ana, w.id, { minutes: 50, note: "x" }); // no change
      await updateWorklog(prisma, ana, w.id, {}); // no change
      const acts = (await prisma.pmActivity.findMany({ where: { workItemId: wi.id }, orderBy: { createdAt: "asc" } })).filter(
        (a) => a.verb === "time_log_updated",
      );
      expect(acts).toHaveLength(1);
      expect(acts[0]).toMatchObject({ oldValue: "30", newValue: "50", actorId: ana.id });
    });

    it("clearing a note is an ordinary write, not a silently ignored one", async () => {
      const wi = await item();
      const w = await createWorklog(prisma, ana, wi.id, { minutes: 30, note: "something" });
      const cleared = await updateWorklog(prisma, ana, w.id, { note: "" });
      expect(cleared.note).toBe("");
      expect((await prisma.pmWorklog.findUniqueOrThrow({ where: { id: w.id } })).note).toBe("");
    });

    it("a delete writes time_log_removed carrying the minutes it held", async () => {
      const wi = await item();
      const w = await createWorklog(prisma, ana, wi.id, { minutes: 25 });
      await deleteWorklog(prisma, ana, w.id);
      const acts = await prisma.pmActivity.findMany({ where: { workItemId: wi.id, verb: "time_log_removed" } });
      expect(acts).toHaveLength(1);
      expect(acts[0]).toMatchObject({ oldValue: "25", newValue: null, actorId: ana.id });
    });

    it("lists newest first with a total over EVERY entry, not only the page shown", async () => {
      const wi = await item();
      await createWorklog(prisma, ana, wi.id, { minutes: 10, startedAt: at("2026-10-01T09:00:00.000Z") }, NOW);
      await createWorklog(prisma, ben, wi.id, { minutes: 20, startedAt: at("2026-10-03T09:00:00.000Z") }, NOW);
      await createWorklog(prisma, ana, wi.id, { minutes: 30, startedAt: at("2026-10-02T09:00:00.000Z") }, NOW);
      const list = await listWorklogs(prisma, wi.id);
      expect(list.worklogs.map((w) => w.minutes)).toEqual([20, 30, 10]);
      expect(list).toMatchObject({ totalMinutes: 60, totalEntries: 3 });
      await expect(listWorklogs(prisma, "warp3526-missing")).rejects.toThrow("work_item_not_found");
    });
  });

  // ── a timer racing the deletion of an item ──────────────────────────────

  describe("a timer racing the deletion of an item (review S3)", () => {
    /**
     * Delete `itemId` in a transaction that stays OPEN until `release()`. While it
     * is open the row is locked, so a concurrent insert that references the item
     * waits on it - and when the delete then commits, that insert fails its foreign
     * key: the race, staged deterministically instead of hoped for.
     */
    async function holdDeleteOpen(itemId: string) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let deleted!: () => void;
      const hasDeleted = new Promise<void>((resolve) => {
        deleted = resolve;
      });
      const done = prisma.$transaction(
        async (tx) => {
          await tx.pmWorkItem.delete({ where: { id: itemId } });
          deleted();
          await gate;
        },
        { timeout: 30_000, maxWait: 30_000 },
      );
      await hasDeleted;
      return { release, done };
    }

    /** Wait until a backend is blocked on a lock inside an INSERT into `table`. */
    async function waitUntilInsertIsBlocked(table: "PmWorklog" | "PmTimer"): Promise<void> {
      const needle = `%INSERT INTO%${table}%`;
      for (let i = 0; i < 200; i += 1) {
        const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*)::bigint AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE ${needle}`;
        if (Number(rows[0].n) > 0) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`nothing ever blocked inserting into ${table}: the race this test stages did not happen`);
    }

    it("stopping a timer whose item is deleted at that moment is timer_not_found: the stop rolls back, the timer went with the item", async () => {
      const a = await item(projectA, "stop-vs-delete");
      await startTimer(prisma, ana.id, a.id, at("2026-10-04T09:00:00.000Z"));

      const held = await holdDeleteOpen(a.id);
      const stopping = stopTimer(prisma, ana.id, at("2026-10-04T09:30:00.000Z"));
      const outcome = stopping.then(
        () => "stopped",
        (e: Error) => e.message,
      );
      await waitUntilInsertIsBlocked("PmWorklog");
      held.release();
      await held.done;

      // Not a raw foreign-key error (a 500): the honest answer is that there is no timer to stop.
      expect(await outcome).toBe("timer_not_found");
      expect(await getTimer(prisma, ana.id)).toBeNull();
      expect(await prisma.pmWorklog.count({ where: { userId: ana.id } })).toBe(0);
    });

    it("starting a timer while the PREVIOUS timer's item is deleted is a retryable conflict, not 'item not found' for an item that exists", async () => {
      const old = await item(projectA, "old-item");
      const next = await item(projectA, "next-item");
      await startTimer(prisma, ana.id, old.id, at("2026-10-04T09:00:00.000Z"));

      const held = await holdDeleteOpen(old.id);
      const starting = startTimer(prisma, ana.id, next.id, at("2026-10-04T09:30:00.000Z"));
      const outcome = starting.then(
        () => "started",
        (e: Error) => e.message,
      );
      await waitUntilInsertIsBlocked("PmWorklog"); // stopping the old timer writes its worklog
      held.release();
      await held.done;

      // The item being started EXISTS; what vanished is the old timer's. Nothing was applied.
      expect(await outcome).toBe("concurrent_mutation");
      expect(await getTimer(prisma, ana.id)).toBeNull();

      // ...and trying again simply works: the old timer went with its item, so there is nothing to stop.
      const again = await startTimer(prisma, ana.id, next.id, at("2026-10-04T09:31:00.000Z"));
      expect(again.stopped).toBeNull();
      expect(again.timer.workItemId).toBe(next.id);
      expect(await prisma.pmWorklog.count({ where: { userId: ana.id } })).toBe(0);
    });

    it("starting a timer on an item that is deleted at that moment is still work_item_not_found", async () => {
      const doomed = await item(projectA, "doomed");
      const held = await holdDeleteOpen(doomed.id);
      const starting = startTimer(prisma, ana.id, doomed.id);
      const outcome = starting.then(
        () => "started",
        (e: Error) => e.message,
      );
      await waitUntilInsertIsBlocked("PmTimer");
      held.release();
      await held.done;
      expect(await outcome).toBe("work_item_not_found");
      expect(await getTimer(prisma, ana.id)).toBeNull();
    });
  });

  // ── whose entry it was ────────────────────────────────────────────────────

  describe("the activity row records whose entry it was when somebody else acted on it (review S7)", () => {
    const worklogRows = async (workItemId: string) =>
      (await prisma.pmActivity.findMany({ where: { workItemId }, orderBy: { createdAt: "asc" } })).filter((a) =>
        a.verb.startsWith("time_log"),
      );

    it("an owner or admin removing a member's entry is 'worklog:<owner of the entry>'; the member removing their own is plain 'worklog'", async () => {
      const wi = await item();
      const hers = await createWorklog(prisma, ana, wi.id, { minutes: 90 });
      const his = await createWorklog(prisma, ben, wi.id, { minutes: 20 });

      await deleteWorklog(prisma, boss, hers.id);
      await deleteWorklog(prisma, ben, his.id);

      const removed = (await worklogRows(wi.id)).filter((a) => a.verb === "time_log_removed");
      expect(removed).toHaveLength(2);
      expect(removed[0]).toMatchObject({ actorId: boss.id, field: `worklog:${ana.id}`, oldValue: "90" });
      expect(removed[1]).toMatchObject({ actorId: ben.id, field: "worklog", oldValue: "20" });
    });

    it("an owner or admin editing a member's entry says whose it was; a member editing their own does not need to", async () => {
      const wi = await item();
      const hers = await createWorklog(prisma, ana, wi.id, { minutes: 30 });

      await updateWorklog(prisma, boss, hers.id, { minutes: 40 });
      await updateWorklog(prisma, ana, hers.id, { minutes: 50 });

      const updated = (await worklogRows(wi.id)).filter((a) => a.verb === "time_log_updated");
      expect(updated).toHaveLength(2);
      expect(updated[0]).toMatchObject({ actorId: boss.id, field: `worklog:${ana.id}`, oldValue: "30", newValue: "40" });
      expect(updated[1]).toMatchObject({ actorId: ana.id, field: "worklog", oldValue: "40", newValue: "50" });
    });

    it("logging time on someone's behalf says for whom; logging your own, by hand or by stopping a timer, does not", async () => {
      const wi = await item();
      const sam = await prisma.user.create({ data: { username: "warp3526-sam", displayName: "Sam Test" } });
      await createWorklog(prisma, boss, wi.id, { minutes: 45, userId: sam.id }, NOW);
      await createWorklog(prisma, ana, wi.id, { minutes: 15 });
      await startTimer(prisma, ben.id, wi.id, at("2026-10-04T09:00:00.000Z"));
      await stopTimer(prisma, ben.id, at("2026-10-04T09:10:00.000Z"));

      const logged = (await worklogRows(wi.id)).filter((a) => a.verb === "time_logged");
      expect(logged.map((a) => [a.actorId, a.field, a.newValue])).toEqual([
        [boss.id, `worklog:${sam.id}`, "45"],
        [ana.id, "worklog", "15"],
        [ben.id, "worklog", "10"],
      ]);
    });
  });

  // ── timesheet ────────────────────────────────────────────────────────────

  describe("getTimesheet", () => {
    it("lays one person's week out Monday to Sunday in THEIR zone, and an entry sits in the day it started on", async () => {
      const a = await item(projectA, "sheet-a");
      const b = await item(projectB, "sheet-b");
      const log = (wi: string, minutes: number, iso: string) =>
        prisma.pmWorklog.create({ data: { workItemId: wi, userId: ana.id, startedAt: at(iso), minutes } });
      // Week of Mon 2026-10-26 in New York (the week the clocks fall back).
      await log(a.id, 60, "2026-10-26T13:00:00.000Z"); // Mon 09:00 EDT
      await log(a.id, 30, "2026-10-26T14:00:00.000Z"); // Mon again
      await log(b.id, 45, "2026-10-28T15:00:00.000Z"); // Wed
      await log(a.id, 20, "2026-11-02T04:50:00.000Z"); // 23:50 SUNDAY EST — UTC says Monday
      await log(a.id, 99, "2026-11-02T05:00:00.000Z"); // Mon 00:00 EST — next week
      await log(a.id, 98, "2026-10-26T03:59:00.000Z"); // Sun 23:59 EDT — previous week
      await prisma.pmWorklog.create({
        data: { workItemId: a.id, userId: ben.id, startedAt: at("2026-10-27T15:00:00.000Z"), minutes: 77 },
      }); // someone else's

      const sheet = await getTimesheet(prisma, { userId: ana.id, weekStart: "2026-10-28", tz: "America/New_York" });
      expect(sheet).toMatchObject({
        userId: ana.id,
        tz: "America/New_York",
        weekStart: "2026-10-26",
        days: ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"],
        dayTotals: [90, 0, 45, 0, 0, 0, 20],
        totalMinutes: 155,
      });
      expect(sheet.rows.map((r) => ({ key: r.workItem.key, minutes: r.minutes, total: r.totalMinutes }))).toEqual([
        { key: "W35A-1", minutes: [90, 0, 0, 0, 0, 0, 20], total: 110 },
        { key: "W35B-2", minutes: [0, 0, 45, 0, 0, 0, 0], total: 45 },
      ]);
      // The same week read in UTC files that 04:50Z entry under Monday of the NEXT week instead.
      const utc = await getTimesheet(prisma, { userId: ana.id, weekStart: "2026-10-26" });
      expect(utc.tz).toBe("UTC");
      expect(utc.entries.some((e) => e.minutes === 20)).toBe(false);
      // The entries list is the same data, newest first, each with its item.
      expect(sheet.entries.map((e) => e.minutes)).toEqual([20, 45, 30, 60]);
      expect(sheet.entries[0].workItem.key).toBe("W35A-1");
    });

    it("refuses a zone or a date it cannot read instead of guessing UTC or today", async () => {
      await expect(getTimesheet(prisma, { userId: ana.id, tz: "Mars/Base" })).rejects.toThrow("invalid_timezone");
      await expect(getTimesheet(prisma, { userId: ana.id, weekStart: "2026-02-30" })).rejects.toThrow(
        "invalid_week_start",
      );
    });

    it("refuses a year no calendar means (review S4): 9999 used to crash the converter, 0001 was quietly read as 1901", async () => {
      for (const weekStart of ["9999-12-27", "9999-12-31", "0001-01-01", "0099-12-31"]) {
        await expect(getTimesheet(prisma, { userId: ana.id, weekStart }), weekStart).rejects.toThrow(
          "invalid_week_start",
        );
      }
    });
  });

  // ── report ───────────────────────────────────────────────────────────────

  describe("getTimeReport — totals are the sum of the worklogs", () => {
    async function seed() {
      const sam = await prisma.user.create({ data: { username: "warp3526-sam", displayName: "Sam Test" } });
      const a1 = await item(projectA, "r-a1");
      const a2 = await item(projectA, "r-a2");
      const b1 = await item(projectB, "r-b1");
      const log = (wi: string, userId: string, minutes: number, iso: string) =>
        prisma.pmWorklog.create({ data: { workItemId: wi, userId, startedAt: at(iso), minutes } });
      await log(a1.id, ana.id, 60, "2026-09-29T14:00:00.000Z");
      await log(a1.id, ben.id, 30, "2026-09-29T15:00:00.000Z");
      await log(a2.id, ana.id, 15, "2026-09-30T13:00:00.000Z");
      await log(b1.id, sam.id, 120, "2026-09-30T20:00:00.000Z");
      await log(b1.id, ana.id, 45, "2026-10-01T01:30:00.000Z"); // Sep 30 in New York
      await log(a2.id, ben.id, 5, "2026-10-02T12:00:00.000Z");
      return { sam, a1, a2, b1 };
    }

    it("equals a direct SUM for every grouping, in UTC and in another zone", async () => {
      await seed();
      for (const tz of ["UTC", "America/New_York", "Pacific/Auckland"]) {
        const direct = await sumMinutes();
        for (const groupBy of ["user", "item", "day"] as const) {
          const r = await getTimeReport(prisma, { from: "2026-09-25", to: "2026-10-05", groupBy, tz });
          expect(r.total.minutes, `${groupBy}/${tz} total`).toBe(direct);
          expect(r.rows.reduce((n, row) => n + row.minutes, 0), `${groupBy}/${tz} rows`).toBe(direct);
          expect(r.rows.reduce((n, row) => n + row.entries, 0), `${groupBy}/${tz} entries`).toBe(6);
          expect(r.total.entries).toBe(6);
        }
      }
    });

    it("groups by person (with display names), by item (with keys) and by local day", async () => {
      const { sam } = await seed();
      const range = { from: "2026-09-25", to: "2026-10-05" };

      const users = await getTimeReport(prisma, { ...range, groupBy: "user" });
      expect(users.rows.map((r) => [r.label, r.minutes])).toEqual([
        ["Sam Test", 120],
        [ana.id, 120], // no directory row: the id, not an invented name
        [ben.id, 35],
      ]);
      expect(users.rows[0]).toMatchObject({ key: sam.id, itemKey: null });

      const items = await getTimeReport(prisma, { ...range, groupBy: "item" });
      expect(items.rows.map((r) => [r.itemKey, r.label, r.minutes])).toEqual([
        ["W35B-3", "warp3526-r-b1", 165],
        ["W35A-1", "warp3526-r-a1", 90],
        ["W35A-2", "warp3526-r-a2", 20],
      ]);

      const days = await getTimeReport(prisma, { ...range, groupBy: "day" });
      expect(days.rows.map((r) => [r.key, r.label, r.minutes])).toEqual([
        ["2026-09-29", "2026-09-29", 90],
        ["2026-09-30", "2026-09-30", 135],
        ["2026-10-01", "2026-10-01", 45],
        ["2026-10-02", "2026-10-02", 5],
      ]);
      // In New York the 01:30Z entry belongs to Sep 30, so that day grows.
      const ny = await getTimeReport(prisma, { ...range, groupBy: "day", tz: "America/New_York" });
      expect(ny.rows.find((r) => r.key === "2026-09-30")?.minutes).toBe(180);
      expect(ny.rows.find((r) => r.key === "2026-10-01")).toBeUndefined();
    });

    it("narrows to one project, and refuses a project that does not exist", async () => {
      await seed();
      const r = await getTimeReport(prisma, {
        projectId: projectB,
        from: "2026-09-25",
        to: "2026-10-05",
        groupBy: "user",
      });
      expect(r.projectId).toBe(projectB);
      expect(r.total).toEqual({ minutes: 165, entries: 2 });
      await expect(
        getTimeReport(prisma, { projectId: "warp3526-no-project", from: "2026-09-25", to: "2026-10-05" }),
      ).rejects.toThrow("project_not_found");
    });

    it("includes the first local midnight and excludes the one after the last day", async () => {
      const a = await item();
      const log = (iso: string, minutes: number) =>
        prisma.pmWorklog.create({ data: { workItemId: a.id, userId: ana.id, startedAt: at(iso), minutes } });
      await log("2026-09-30T03:59:59.000Z", 1); // Sep 29 23:59:59 EDT — before
      await log("2026-09-30T04:00:00.000Z", 2); // Sep 30 00:00:00 EDT — first instant
      await log("2026-10-01T03:59:59.000Z", 4); // Sep 30 23:59:59 EDT — last instant
      await log("2026-10-01T04:00:00.000Z", 8); // Oct 1 00:00:00 EDT — after
      const r = await getTimeReport(prisma, {
        from: "2026-09-30",
        to: "2026-09-30",
        groupBy: "day",
        tz: "America/New_York",
      });
      expect(r.total).toEqual({ minutes: 6, entries: 2 });
    });

    it("sums correctly across page boundaries: 2,100 entries, no repeat and no skip", async () => {
      const a = await item();
      const rows = Array.from({ length: 2100 }, (_, i) => ({
        workItemId: a.id,
        userId: i % 2 === 0 ? ana.id : ben.id,
        startedAt: at("2026-10-01T12:00:00.000Z"),
        minutes: (i % 90) + 1,
      }));
      await prisma.pmWorklog.createMany({ data: rows });
      const expected = rows.reduce((n, r) => n + r.minutes, 0);
      expect(await sumMinutes()).toBe(expected);
      for (const groupBy of ["user", "item", "day"] as const) {
        const r = await getTimeReport(prisma, { from: "2026-10-01", to: "2026-10-01", groupBy });
        expect(r.total, groupBy).toEqual({ minutes: expected, entries: 2100 });
        expect(r.rows.reduce((n, row) => n + row.minutes, 0), groupBy).toBe(expected);
      }
    });

    it("refuses a range that runs backwards or is longer than a year and a day", async () => {
      await expect(getTimeReport(prisma, { from: "2026-10-05", to: "2026-10-04" })).rejects.toThrow("invalid_range");
      await expect(getTimeReport(prisma, { from: "2025-01-01", to: "2026-01-02" })).rejects.toThrow("invalid_range");
    });

    it("refuses a year no calendar means (review S4), whichever end of the range it is on", async () => {
      for (const [from, to] of [
        ["9999-12-30", "9999-12-31"],
        ["0001-01-01", "0001-01-02"],
        ["2026-01-01", "9999-12-31"],
      ]) {
        await expect(getTimeReport(prisma, { from, to }), `${from}..${to}`).rejects.toThrow("invalid_range");
      }
    });
  });
});
