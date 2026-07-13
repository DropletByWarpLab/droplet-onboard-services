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
} from "./transitions.js";

interface Row {
  id: string;
  status: string;
  failureReason: string | null;
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
        where: { id?: string; status?: string };
        data: { status?: string; failureReason?: string | null };
      }) => {
        let count = 0;
        for (const row of rows) {
          if (args.where.id !== undefined && row.id !== args.where.id) continue;
          if (args.where.status !== undefined && row.status !== args.where.status) continue;
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
      verifying: ["applying", "rejected"],
      applying: ["committed", "rolled_back", "failed"],
      superseded: [],
      committed: [],
      rolled_back: [],
      failed: [],
      rejected: [],
    });
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
});
