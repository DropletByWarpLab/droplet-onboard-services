/**
 * WARP-541 — the DeviceUpdate advance-only guard.
 *
 * The audit table's integrity contract: rows are append-only and status
 * only ever ADVANCES through the allowed-transition map. These tests pin
 * the map itself, prove a backwards / terminal-escaping / concurrent
 * write throws (never silently lands), and prove the supersede sweep can
 * only touch `pending` rows.
 */
import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type pino from "pino";
import {
  DEVICE_UPDATE_ALLOWED_TRANSITIONS,
  DeviceUpdateTransitionError,
  assertTransitionAllowed,
  transitionDeviceUpdate,
  supersedePendingUpdates,
  supersedeUnclaimedVerifyingUpdates,
  installedRelease,
  recordCommittedOutcome,
  onDeviceUpdateTransition,
} from "./transitions.js";

interface Row {
  id: string;
  status: string;
  failureReason: string | null;
  outcome?: string;
  releaseTag?: string | null;
  /** WARP-3193 PERF-3 — only the parked-row sweep reads it. */
  applyClaim?: string;
}

function createPrismaStub(rows: Row[]) {
  return {
    deviceUpdate: {
      _rows: () => rows,
      findFirst: async (args: { where: { id?: string; status?: string } }) => {
        const row = rows.find(
          (r) =>
            (args.where.id === undefined || r.id === args.where.id) &&
            (args.where.status === undefined || r.status === args.where.status),
        );
        return row ? { ...row } : null;
      },
      updateMany: async (args: {
        where: { id?: string; status?: string; applyClaim?: string };
        data: { status?: string; failureReason?: string | null; outcome?: string };
      }) => {
        let count = 0;
        for (const row of rows) {
          if (args.where.id !== undefined && row.id !== args.where.id) continue;
          if (args.where.status !== undefined && row.status !== args.where.status) continue;
          if (args.where.applyClaim !== undefined && row.applyClaim !== args.where.applyClaim) continue;
          if (args.data.outcome !== undefined) row.outcome = args.data.outcome;
          if (args.data.status !== undefined) row.status = args.data.status;
          if ("failureReason" in args.data) row.failureReason = args.data.failureReason ?? null;
          count += 1;
        }
        return { count };
      },
    },
  };
}

const asPrisma = (stub: ReturnType<typeof createPrismaStub>) =>
  stub as never as PrismaClient;

function loggerSpy() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe("DeviceUpdate advance-only transitions (WARP-541)", () => {
  it("pins the allowed-transition map to the schema diagram", () => {
    expect(DEVICE_UPDATE_ALLOWED_TRANSITIONS).toEqual({
      pending: ["superseded", "verifying"],
      // WARP-3430: a parked row can be retired (a newer release overtook it, or
      // it went stale); applying and the terminal statuses stay as they were.
      verifying: ["applying", "rejected", "superseded"],
      applying: ["committed", "rolled_back", "failed"],
      superseded: [],
      committed: [],
      rolled_back: [],
      failed: [],
      rejected: [],
    });
  });

  it("verifying → superseded advances, and the row is then terminal (WARP-3430)", async () => {
    const rows: Row[] = [{ id: "du-1", status: "verifying", failureReason: null }];
    const prisma = asPrisma(createPrismaStub(rows));
    await transitionDeviceUpdate(prisma, { id: "du-1", to: "superseded", failureReason: "not_newer" });
    expect(rows[0]).toEqual({ id: "du-1", status: "superseded", failureReason: "not_newer" });
    await expect(
      transitionDeviceUpdate(prisma, { id: "du-1", to: "applying" }),
    ).rejects.toThrow(/advance-only/);
  });

  it("applying still cannot be superseded", () => {
    expect(() => assertTransitionAllowed("du-1", "applying", "superseded")).toThrow(/advance-only/);
  });

  it("advances every allowed edge and records failureReason", async () => {
    const rows: Row[] = [{ id: "du-1", status: "pending", failureReason: null }];
    const prisma = asPrisma(createPrismaStub(rows));
    await transitionDeviceUpdate(prisma, { id: "du-1", to: "verifying" });
    await transitionDeviceUpdate(prisma, { id: "du-1", to: "applying" });
    await transitionDeviceUpdate(prisma, {
      id: "du-1",
      to: "rolled_back",
      failureReason: "health_gate_failed",
    });
    expect(rows[0]).toEqual({
      id: "du-1",
      status: "rolled_back",
      failureReason: "health_gate_failed",
    });
  });

  it("throws on a BACKWARDS transition and leaves the row untouched", async () => {
    const rows: Row[] = [{ id: "du-1", status: "applying", failureReason: null }];
    const prisma = asPrisma(createPrismaStub(rows));
    await expect(
      transitionDeviceUpdate(prisma, { id: "du-1", to: "verifying" }),
    ).rejects.toThrow(DeviceUpdateTransitionError);
    expect(rows[0]!.status).toBe("applying");
  });

  it("throws when a TERMINAL row is written to at all", async () => {
    for (const terminal of ["superseded", "committed", "rolled_back", "failed", "rejected"]) {
      const rows: Row[] = [{ id: "du-1", status: terminal, failureReason: null }];
      const prisma = asPrisma(createPrismaStub(rows));
      await expect(
        transitionDeviceUpdate(prisma, { id: "du-1", to: "applying" }),
      ).rejects.toThrow(/advance-only/);
      expect(rows[0]!.status).toBe(terminal);
    }
  });

  it("throws (not upsert) when the row does not exist", async () => {
    const prisma = asPrisma(createPrismaStub([]));
    await expect(
      transitionDeviceUpdate(prisma, { id: "du-missing", to: "verifying" }),
    ).rejects.toThrow(/no such row/);
  });

  it("throws when the row moved concurrently between read and write", async () => {
    const rows: Row[] = [{ id: "du-1", status: "pending", failureReason: null }];
    const stub = createPrismaStub(rows);
    // Another writer supersedes the row between our findFirst and updateMany.
    const originalFindFirst = stub.deviceUpdate.findFirst;
    stub.deviceUpdate.findFirst = async (args) => {
      const result = await originalFindFirst(args);
      rows[0]!.status = "superseded";
      return result;
    };
    await expect(
      transitionDeviceUpdate(asPrisma(stub), { id: "du-1", to: "verifying" }),
    ).rejects.toThrow(/concurrently/);
    expect(rows[0]!.status).toBe("superseded");
  });

  it("emits one update.status_transition debug event per write", async () => {
    const rows: Row[] = [{ id: "du-1", status: "pending", failureReason: null }];
    const logger = loggerSpy();
    await transitionDeviceUpdate(asPrisma(createPrismaStub(rows)), {
      id: "du-1",
      to: "verifying",
      logger: logger as never as pino.Logger,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "update.status_transition",
        deviceUpdateId: "du-1",
        from: "pending",
        to: "verifying",
        failureReason: null,
      }),
      expect.any(String),
    );
  });

  it("assertTransitionAllowed refuses an unknown current status", () => {
    expect(() => assertTransitionAllowed("du-1", "hand-edited", "verifying")).toThrow(
      /not a known/,
    );
  });

  it("supersedePendingUpdates only ever touches pending rows", async () => {
    const rows: Row[] = [
      { id: "du-1", status: "pending", failureReason: null },
      { id: "du-2", status: "pending", failureReason: null },
      { id: "du-3", status: "applying", failureReason: null },
      { id: "du-4", status: "committed", failureReason: null },
    ];
    const count = await supersedePendingUpdates(asPrisma(createPrismaStub(rows)));
    expect(count).toBe(2);
    expect(rows.map((r) => r.status)).toEqual([
      "superseded",
      "superseded",
      "applying",
      "committed",
    ]);
  });

  it("supersedeUnclaimedVerifyingUpdates retires parked rows and nothing else (WARP-3430)", async () => {
    const rows: Row[] = [
      { id: "du-1", status: "verifying", failureReason: null, applyClaim: "unclaimed" },
      // Mid-apply: a runner holds it, so the sweep must not change it under them.
      { id: "du-2", status: "verifying", failureReason: null, applyClaim: "claimed" },
      { id: "du-3", status: "pending", failureReason: null, applyClaim: "unclaimed" },
      { id: "du-4", status: "applying", failureReason: null, applyClaim: "claimed" },
      { id: "du-5", status: "committed", failureReason: null, applyClaim: "unclaimed" },
    ];
    const count = await supersedeUnclaimedVerifyingUpdates(asPrisma(createPrismaStub(rows)));
    expect(count).toBe(1);
    expect(rows.map((r) => r.status)).toEqual([
      "superseded",
      "verifying",
      "pending",
      "applying",
      "committed",
    ]);
  });

  it("installedRelease asks for the newest COMMITTED row — the read health-monitor and the status route use", async () => {
    // One query shared by the poller's floor and apply's re-check; pin its shape.
    const findFirst = vi.fn().mockResolvedValue({ builtAt: new Date("2026-06-30T03:00:00Z"), gitSha: "b".repeat(40) });
    const res = await installedRelease({ deviceUpdate: { findFirst } } as never);
    expect(findFirst).toHaveBeenCalledWith({
      where: { status: "committed" },
      orderBy: { updatedAt: "desc" },
      select: { builtAt: true, gitSha: true },
    });
    expect(res).toEqual({ builtAt: new Date("2026-06-30T03:00:00Z"), gitSha: "b".repeat(40) });
  });
});

describe("DeviceUpdate outcome (WARP-3007)", () => {
  it("a status transition carries its outcome in the same guarded write", async () => {
    const stub = createPrismaStub([{ id: "du-1", status: "applying", failureReason: null }]);
    await transitionDeviceUpdate(asPrisma(stub), {
      id: "du-1",
      to: "rolled_back",
      failureReason: "health_gate_failed",
      outcome: "rolled_back",
    });
    expect(stub.deviceUpdate._rows()[0]).toMatchObject({ status: "rolled_back", outcome: "rolled_back" });
  });

  it("the post-commit outcome only ever lands on a committed row", async () => {
    const stub = createPrismaStub([
      { id: "du-1", status: "committed", failureReason: null, outcome: "starting_services" },
      { id: "du-2", status: "rolled_back", failureReason: "health_gate_failed", outcome: "rolled_back" },
    ]);
    expect(
      await recordCommittedOutcome(asPrisma(stub), { id: "du-1", outcome: "services_start_failed" }),
    ).toBe(true);
    expect(await recordCommittedOutcome(asPrisma(stub), { id: "du-2", outcome: "committed" })).toBe(false);
    expect(stub.deviceUpdate._rows().map((r) => r.outcome)).toEqual([
      "services_start_failed",
      "rolled_back",
    ]);
  });
});

describe("onDeviceUpdateTransition (WARP-3504)", () => {
  it("tells every observer about a status write AFTER it landed, with the release tag", async () => {
    const rows: Row[] = [{ id: "du-1", status: "applying", failureReason: null, releaseTag: "ota-stage-9-gabc1234" }];
    const prisma = asPrisma(createPrismaStub(rows));
    const seen = vi.fn();
    const off = onDeviceUpdateTransition((t) => {
      // The write is already visible to the observer.
      seen({ ...t, rowStatus: rows[0]!.status });
    });

    await transitionDeviceUpdate(prisma, { id: "du-1", to: "rolled_back", failureReason: "health_gate_failed" });
    off();

    expect(seen).toHaveBeenCalledWith({
      id: "du-1",
      from: "applying",
      to: "rolled_back",
      failureReason: "health_gate_failed",
      releaseTag: "ota-stage-9-gabc1234",
      rowStatus: "rolled_back",
    });
  });

  it("an observer that throws cannot fail the status write, and an unsubscribed one is silent", async () => {
    const rows: Row[] = [{ id: "du-1", status: "pending", failureReason: null }];
    const prisma = asPrisma(createPrismaStub(rows));
    const gone = vi.fn();
    onDeviceUpdateTransition(gone)();
    const off = onDeviceUpdateTransition(() => {
      throw new Error("consumer bug");
    });

    await expect(transitionDeviceUpdate(prisma, { id: "du-1", to: "verifying" })).resolves.toBeUndefined();
    off();

    expect(rows[0]!.status).toBe("verifying");
    expect(gone).not.toHaveBeenCalled();
  });

  it("is not told about a refused transition", async () => {
    const rows: Row[] = [{ id: "du-1", status: "committed", failureReason: null }];
    const prisma = asPrisma(createPrismaStub(rows));
    const seen = vi.fn();
    const off = onDeviceUpdateTransition(seen);

    await expect(transitionDeviceUpdate(prisma, { id: "du-1", to: "applying" })).rejects.toThrow(/advance-only/);
    off();

    expect(seen).not.toHaveBeenCalled();
  });
});
