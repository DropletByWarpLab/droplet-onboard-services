/**
 * WARP-2180 — agent-run-schedule ticker: due rows ENQUEUE a run attributed
 * to the schedule's creator (never executed here), `nextFireAt` advances,
 * in-future rows do not fire, and a rule that no longer parses disables the
 * schedule with a `system` row instead of pinning the ticker. Enqueue and
 * advance are one transaction: a failed advance leaves no run behind, and
 * the next tick fires the slot exactly once. A schedule whose owner no longer
 * exists is disabled with a `system` row instead of firing a run that could
 * only fail (`AgentRunSchedule.userId` has no FK — WARP-2744 item 4).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    agentMaxIter: { defaultIter: 10, capIter: 10 },
    agentRuns: { concurrency: 1, tickMs: 5_000, heartbeatMs: 15_000, reclaimAfterMs: 60_000, maxAttempts: 3, maxWallMs: 2_400_000, maxIter: 10 },
  },
}));
const { recordActivityMock } = vi.hoisted(() => ({ recordActivityMock: vi.fn().mockResolvedValue(null) }));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: recordActivityMock }));
vi.mock("../services/notifications.service.js", () => ({ sendNotification: vi.fn() }));

import { tickAgentRunSchedules } from "../services/agent-run-schedule-ticker.service.js";
import { enqueueAgentRun } from "../services/agent-run-worker.service.js";
import { createAgentRunPrismaMock } from "./helpers/agent-run-prisma-mock.js";

const OWNER = { id: "u-owner", username: "romain", role: "owner" };

beforeEach(() => recordActivityMock.mockClear());

describe("agent-run-schedule ticker (WARP-2180)", () => {
  it("fires due schedules as queued runs attributed to the creator, advances nextFireAt, leaves future ones alone", async () => {
    const now = new Date("2026-09-04T06:00:30Z");
    const db = createAgentRunPrismaMock({ users: [OWNER], now: () => now });
    await db.prisma.agentRunSchedule.create({
      data: { userId: "u-owner", goal: "sweep last night's clips", model: "m", maxIter: 10, rrule: "FREQ=DAILY;BYHOUR=6;BYMINUTE=0", timezone: "UTC", nextFireAt: new Date("2026-09-04T06:00:00Z") },
    });
    await db.prisma.agentRunSchedule.create({
      data: { userId: "u-owner", goal: "later", model: "m", maxIter: 10, rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", timezone: "UTC", nextFireAt: new Date("2026-09-04T09:00:00Z") },
    });
    const counts = await tickAgentRunSchedules(db.prisma, now);
    expect(counts).toEqual({ inspected: 1, fired: 1, disabled: 0, skipped: 0, skippedOverlap: 0 });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ userId: "u-owner", goal: "sweep last night's clips", status: "queued", maxIter: 10 });
    expect(db.rows[0]!.runAfter).toEqual(new Date("2026-09-04T06:00:00Z"));
    const fired = db.schedules[0]!;
    expect((fired.nextFireAt as Date).getTime()).toBeGreaterThan(now.getTime());
    expect(fired.lastFiredAt).toEqual(now);
    expect(db.schedules[1]!.lastFiredAt).toBeNull();
  });

  it("disables a schedule whose RRULE no longer parses, with a system row", async () => {
    const now = new Date("2026-09-04T06:00:30Z");
    const db = createAgentRunPrismaMock({ users: [OWNER], now: () => now });
    await db.prisma.agentRunSchedule.create({
      data: { userId: "u-owner", goal: "g", model: "m", maxIter: 10, rrule: "FREQ=NONSENSE", timezone: "UTC", nextFireAt: new Date("2026-09-04T06:00:00Z") },
    });
    const counts = await tickAgentRunSchedules(db.prisma, now);
    expect(counts).toEqual({ inspected: 1, fired: 1, disabled: 1, skipped: 0, skippedOverlap: 0 });
    expect(db.schedules[0]!.enabled).toBe(false);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "system", severity: "warn", refs: expect.objectContaining({ rrule: "FREQ=NONSENSE" }) }),
    );
  });

  it("enqueue + advance are atomic: a failed advance leaves no run, the next tick fires the slot once", async () => {
    const now = new Date("2026-09-04T06:00:30Z");
    const db = createAgentRunPrismaMock({ users: [OWNER], now: () => now });
    await db.prisma.agentRunSchedule.create({
      data: { userId: "u-owner", goal: "g", model: "m", maxIter: 10, rrule: "FREQ=DAILY;BYHOUR=6;BYMINUTE=0", timezone: "UTC", nextFireAt: new Date("2026-09-04T06:00:00Z") },
    });
    db.prisma.agentRunSchedule.update.mockImplementationOnce(async () => {
      throw new Error("connection reset");
    });
    expect(await tickAgentRunSchedules(db.prisma, now)).toEqual({ inspected: 1, fired: 0, disabled: 0, skipped: 1, skippedOverlap: 0 });
    // Rolled back: no run was enqueued for a schedule that is still due.
    expect(db.rows).toHaveLength(0);
    expect(db.schedules[0]!.lastFiredAt).toBeNull();
    // The next tick retries the whole fire — one run, not two.
    expect(await tickAgentRunSchedules(db.prisma, now)).toEqual({ inspected: 1, fired: 1, disabled: 0, skipped: 0, skippedOverlap: 0 });
    expect(db.rows).toHaveLength(1);
    expect(await tickAgentRunSchedules(db.prisma, now)).toEqual({ inspected: 0, fired: 0, disabled: 0, skipped: 0, skippedOverlap: 0 });
    expect(db.rows).toHaveLength(1);
  });

  it("disables a schedule whose owner no longer exists, with a system row, and enqueues nothing", async () => {
    const now = new Date("2026-09-04T06:00:30Z");
    const db = createAgentRunPrismaMock({ users: [OWNER], now: () => now });
    await db.prisma.agentRunSchedule.create({
      data: { userId: "u-deleted", goal: "g", model: "m", maxIter: 10, rrule: "FREQ=DAILY;BYHOUR=6;BYMINUTE=0", timezone: "UTC", nextFireAt: new Date("2026-09-04T06:00:00Z") },
    });
    expect(await tickAgentRunSchedules(db.prisma, now)).toEqual({ inspected: 1, fired: 0, disabled: 1, skipped: 0, skippedOverlap: 0 });
    expect(db.rows).toHaveLength(0);
    expect(db.schedules[0]).toMatchObject({ enabled: false, lastFiredAt: now });
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "system",
        severity: "warn",
        what: "Agent run schedule disabled (owner no longer exists)",
        refs: expect.objectContaining({ userId: "u-deleted", reason: "user_missing" }),
      }),
    );
    // Disabled means gone from the due set: the next tick inspects nothing.
    expect(await tickAgentRunSchedules(db.prisma, now)).toEqual({ inspected: 0, fired: 0, disabled: 0, skipped: 0, skippedOverlap: 0 });
  });
});

/**
 * WARP-2877 — a schedule must not stack on top of itself.
 *
 * Every due tick used to enqueue a run and advance `nextFireAt` regardless of
 * whether the previous fire was still `queued`, `running` or
 * `awaiting_confirmation`, so a job that outran its period piled up N copies
 * of one goal — each holding an inference slot, racing over the same files.
 * `AgentRun.scheduleId` is the link that makes the question answerable.
 */
describe("agent-run-schedule ticker — overlap guard (WARP-2877)", () => {
  const daily = { rrule: "FREQ=DAILY;BYHOUR=6;BYMINUTE=0", timezone: "UTC" };

  async function dueSchedule(db: ReturnType<typeof createAgentRunPrismaMock>) {
    return (await db.prisma.agentRunSchedule.create({
      data: {
        userId: "u-owner",
        goal: "sweep last night's clips",
        model: "m",
        maxIter: 10,
        ...daily,
        nextFireAt: new Date("2026-09-04T06:00:00Z"),
      },
      select: { id: true },
    })) as unknown as { id: string };
  }

  it("stamps the enqueued run with its schedule", async () => {
    const now = new Date("2026-09-04T06:00:30Z");
    const db = createAgentRunPrismaMock({ users: [OWNER], now: () => now });
    const sched = await dueSchedule(db);
    await tickAgentRunSchedules(db.prisma, now);
    expect(db.rows[0]!.scheduleId).toBe(sched.id);
  });

  it.each(["queued", "running", "awaiting_confirmation"])(
    "skips the fire while the previous run is %s — nextFireAt still advances, nothing is enqueued",
    async (status) => {
      let now = new Date("2026-09-04T06:00:30Z");
      const db = createAgentRunPrismaMock({ users: [OWNER], now: () => now });
      await dueSchedule(db);
      // First slot fires normally.
      expect(await tickAgentRunSchedules(db.prisma, now)).toMatchObject({ fired: 1, skippedOverlap: 0 });
      expect(db.rows).toHaveLength(1);
      db.rows[0]!.status = status;
      const firedAt = db.schedules[0]!.lastFiredAt;

      // The next day comes round and the first run is still going.
      now = new Date("2026-09-05T06:00:30Z");
      expect(await tickAgentRunSchedules(db.prisma, now)).toEqual({
        inspected: 1,
        fired: 0,
        disabled: 0,
        skipped: 0,
        skippedOverlap: 1,
      });
      // Nothing enqueued, the slot is gone (not owed), and `lastFiredAt`
      // still records the last time it ACTUALLY fired.
      expect(db.rows).toHaveLength(1);
      expect((db.schedules[0]!.nextFireAt as Date).getTime()).toBeGreaterThan(now.getTime());
      expect(db.schedules[0]!.lastFiredAt).toEqual(firedAt);
      expect(db.schedules[0]!.enabled).toBe(true);
    },
  );

  it("fires again once the previous run reaches a terminal status", async () => {
    let now = new Date("2026-09-04T06:00:30Z");
    const db = createAgentRunPrismaMock({ users: [OWNER], now: () => now });
    await dueSchedule(db);
    await tickAgentRunSchedules(db.prisma, now);
    db.rows[0]!.status = "running";

    now = new Date("2026-09-05T06:00:30Z");
    expect(await tickAgentRunSchedules(db.prisma, now)).toMatchObject({ fired: 0, skippedOverlap: 1 });
    expect(db.rows).toHaveLength(1);

    // It finishes. The guard stops matching and the next slot fires.
    db.rows[0]!.status = "succeeded";
    now = new Date("2026-09-06T06:00:30Z");
    expect(await tickAgentRunSchedules(db.prisma, now)).toMatchObject({ fired: 1, skippedOverlap: 0 });
    expect(db.rows).toHaveLength(2);
    expect(db.rows[1]!.scheduleId).toBe(db.schedules[0]!.id);
    expect(db.schedules[0]!.lastFiredAt).toEqual(now);
  });

  it("a run from ANOTHER schedule never blocks this one", async () => {
    let now = new Date("2026-09-04T06:00:30Z");
    const db = createAgentRunPrismaMock({ users: [OWNER], now: () => now });
    await dueSchedule(db);
    await tickAgentRunSchedules(db.prisma, now);
    db.rows[0]!.status = "running";
    // A second schedule, due at the same wall clock, with its own history.
    await db.prisma.agentRunSchedule.create({
      data: { userId: "u-owner", goal: "other job", model: "m", maxIter: 10, ...daily, nextFireAt: new Date("2026-09-05T06:00:00Z") },
    });

    now = new Date("2026-09-05T06:00:30Z");
    expect(await tickAgentRunSchedules(db.prisma, now)).toMatchObject({
      inspected: 2,
      fired: 1,
      skippedOverlap: 1,
    });
    expect(db.rows.map((r) => r.goal)).toEqual(["sweep last night's clips", "other job"]);
  });

  it("a chat-started run (no scheduleId) never blocks a schedule", async () => {
    const now = new Date("2026-09-04T06:00:30Z");
    const db = createAgentRunPrismaMock({ users: [OWNER], now: () => now });
    await dueSchedule(db);
    await enqueueAgentRun(db.prisma, { userId: "u-owner", goal: "ad-hoc", model: "m" });
    expect(await tickAgentRunSchedules(db.prisma, now)).toMatchObject({ fired: 1, skippedOverlap: 0 });
    expect(db.rows).toHaveLength(2);
  });

  it("an overlapping fire whose RRULE no longer parses is still disabled, and still announced", async () => {
    let now = new Date("2026-09-04T06:00:30Z");
    const db = createAgentRunPrismaMock({ users: [OWNER], now: () => now });
    await dueSchedule(db);
    await tickAgentRunSchedules(db.prisma, now);
    db.rows[0]!.status = "running";
    db.schedules[0]!.rrule = "FREQ=NONSENSE";

    now = new Date("2026-09-05T06:00:30Z");
    expect(await tickAgentRunSchedules(db.prisma, now)).toEqual({
      inspected: 1,
      fired: 0,
      disabled: 1,
      skipped: 0,
      skippedOverlap: 1,
    });
    expect(db.schedules[0]!.enabled).toBe(false);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "system", refs: expect.objectContaining({ rrule: "FREQ=NONSENSE" }) }),
    );
  });
});
