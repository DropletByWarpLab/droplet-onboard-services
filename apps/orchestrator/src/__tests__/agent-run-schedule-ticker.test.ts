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
    expect(counts).toEqual({ inspected: 1, fired: 1, disabled: 0, skipped: 0 });
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
    expect(counts).toEqual({ inspected: 1, fired: 1, disabled: 1, skipped: 0 });
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
    expect(await tickAgentRunSchedules(db.prisma, now)).toEqual({ inspected: 1, fired: 0, disabled: 0, skipped: 1 });
    // Rolled back: no run was enqueued for a schedule that is still due.
    expect(db.rows).toHaveLength(0);
    expect(db.schedules[0]!.lastFiredAt).toBeNull();
    // The next tick retries the whole fire — one run, not two.
    expect(await tickAgentRunSchedules(db.prisma, now)).toEqual({ inspected: 1, fired: 1, disabled: 0, skipped: 0 });
    expect(db.rows).toHaveLength(1);
    expect(await tickAgentRunSchedules(db.prisma, now)).toEqual({ inspected: 0, fired: 0, disabled: 0, skipped: 0 });
    expect(db.rows).toHaveLength(1);
  });

  it("disables a schedule whose owner no longer exists, with a system row, and enqueues nothing", async () => {
    const now = new Date("2026-09-04T06:00:30Z");
    const db = createAgentRunPrismaMock({ users: [OWNER], now: () => now });
    await db.prisma.agentRunSchedule.create({
      data: { userId: "u-deleted", goal: "g", model: "m", maxIter: 10, rrule: "FREQ=DAILY;BYHOUR=6;BYMINUTE=0", timezone: "UTC", nextFireAt: new Date("2026-09-04T06:00:00Z") },
    });
    expect(await tickAgentRunSchedules(db.prisma, now)).toEqual({ inspected: 1, fired: 0, disabled: 1, skipped: 0 });
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
    expect(await tickAgentRunSchedules(db.prisma, now)).toEqual({ inspected: 0, fired: 0, disabled: 0, skipped: 0 });
  });
});
