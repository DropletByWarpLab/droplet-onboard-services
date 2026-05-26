/**
 * WARP-446 — AP discovery poller (blocker #1).
 *
 * Two layers of coverage:
 *  1. `createApDiscoveryPoller(prisma, openwrt).pollOnce()` — the unit:
 *     happy path, empty list, routing failure, re-observation behavior.
 *  2. `startApDiscoveryPoller(cronRuntime, ...)` — the wiring: registers
 *     a `scheduleInterval` handler with the right cadence + advisory
 *     lock key, and the handler actually drives `reconcileDiscovered`.
 *
 * Same shape as device-reconcile-poller.test.ts (narrow client + prisma
 * surface, mock the routing call). The wiring test uses a fake
 * `CronRuntime` so we can capture the handler the production wiring
 * registers and confirm it dispatches end-to-end without spinning real
 * timers.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createApDiscoveryPoller,
  startApDiscoveryPoller,
  type ApDiscoveryOpenwrtClient,
} from "./ap-discovery-poller.js";
import { RouterError } from "../types/router-error.js";
import type { CronRuntime } from "./cron-runtime.service.js";

function createPrismaMock() {
  const rows = new Map<string, any>();
  return {
    rows,
    apDevice: {
      findUnique: vi.fn(async ({ where }: any) => rows.get(where.mac) ?? null),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const existing = rows.get(where.mac);
        if (existing) {
          const merged = { ...existing, ...update, updatedAt: new Date() };
          rows.set(where.mac, merged);
          return merged;
        }
        const row = {
          createdAt: new Date(),
          updatedAt: new Date(),
          firstSeen: new Date(),
          lastSeen: new Date(),
          status: "DISCOVERED",
          ...create,
        };
        rows.set(where.mac, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const existing = rows.get(where.mac);
        if (!existing) {
          const e: any = new Error("not found");
          e.code = "P2025";
          throw e;
        }
        const merged = { ...existing, ...data, updatedAt: new Date() };
        rows.set(where.mac, merged);
        return merged;
      }),
    },
  };
}

function makeOpenwrt(
  overrides: Partial<ApDiscoveryOpenwrtClient> = {},
): ApDiscoveryOpenwrtClient {
  return {
    listDiscoveredAps: overrides.listDiscoveredAps ?? (async () => []),
  };
}

describe("ap-discovery-poller (WARP-446)", () => {
  it("happy path: upserts each observed AP into ApDevice via reconcileDiscovered", async () => {
    const prisma = createPrismaMock();
    const openwrt = makeOpenwrt({
      listDiscoveredAps: async () => [
        {
          mac: "B8:27:EB:00:00:01",
          model: "raspberrypi,5-model-b",
          serial: "RPi5-12345",
          version: "1.0",
          last_ip: "192.168.50.42",
          hostname: "droplet-extender-1",
        },
      ],
    });

    const poller = createApDiscoveryPoller(prisma as any, openwrt);
    await poller.pollOnce();

    expect(prisma.apDevice.upsert).toHaveBeenCalledTimes(1);
    const row = prisma.rows.get("B8:27:EB:00:00:01");
    expect(row).toBeDefined();
    expect(row.status).toBe("AWAITING_APPROVAL");
    expect(row.model).toBe("raspberrypi,5-model-b");
    expect(row.hostname).toBe("droplet-extender-1");
  });

  it("empty list: no upserts, no errors", async () => {
    const prisma = createPrismaMock();
    const openwrt = makeOpenwrt();

    const poller = createApDiscoveryPoller(prisma as any, openwrt);
    await poller.pollOnce();

    expect(prisma.apDevice.upsert).not.toHaveBeenCalled();
  });

  it("routing-service failure does NOT throw — degrades to a logged no-op", async () => {
    const prisma = createPrismaMock();
    const openwrt = makeOpenwrt({
      listDiscoveredAps: async () => {
        throw RouterError.unreachable("routing down");
      },
    });

    const poller = createApDiscoveryPoller(prisma as any, openwrt);
    // No throw — same belt-and-suspenders contract as device-reconcile-poller.
    await expect(poller.pollOnce()).resolves.toBeUndefined();
    expect(prisma.apDevice.upsert).not.toHaveBeenCalled();
  });

  it("startApDiscoveryPoller registers a scheduleInterval handler whose tick drives reconcileDiscovered (AC #1 wiring)", async () => {
    const prisma = createPrismaMock();
    const observed = [
      {
        mac: "B8:27:EB:00:00:42",
        model: "raspberrypi,5-model-b",
        last_ip: "192.168.50.42",
      },
    ];
    const openwrt = makeOpenwrt({
      listDiscoveredAps: vi.fn(async () => observed),
    });

    // Fake cron runtime captures the interval + handler the way
    // production wiring would pass them in.
    let capturedHandler: (() => void | Promise<void>) | null = null;
    let capturedIntervalMs: number | null = null;
    let capturedLockKey: string | null = null;
    const cronRuntime: CronRuntime = {
      scheduleInterval: (ms, handler, opts) => {
        capturedIntervalMs = ms;
        capturedHandler = handler;
        capturedLockKey = opts?.lockKey ?? null;
      },
      scheduleCron: vi.fn(),
      stop: vi.fn(),
    };

    startApDiscoveryPoller(cronRuntime, prisma as any, openwrt, 10_000);

    // Registration happened with the expected interval AND a pg-advisory
    // lock key (multi-instance safety, same shape as the schedule
    // ticker and device reconciler).
    expect(capturedIntervalMs).toBe(10_000);
    expect(capturedLockKey).toBe("droplet:ap-discovery-poller");
    expect(capturedHandler).toBeTypeOf("function");

    // Firing the captured handler ONCE = one scheduler tick. Confirms
    // the wiring actually routes through to reconcileDiscovered, not
    // just sets up the schedule.
    await capturedHandler!();
    expect(openwrt.listDiscoveredAps).toHaveBeenCalledTimes(1);
    expect(prisma.apDevice.upsert).toHaveBeenCalledTimes(1);
    const row = prisma.rows.get("B8:27:EB:00:00:42");
    expect(row?.status).toBe("AWAITING_APPROVAL");
  });

  it("re-observation of a known MAC touches lastSeen without flipping status", async () => {
    const prisma = createPrismaMock();
    const baseline = new Date(Date.now() - 60_000);
    prisma.rows.set("B8:27:EB:00:00:01", {
      mac: "B8:27:EB:00:00:01",
      status: "ONLINE",
      lastSeen: baseline,
      model: "raspberrypi,5-model-b",
    });
    const openwrt = makeOpenwrt({
      listDiscoveredAps: async () => [
        { mac: "B8:27:EB:00:00:01", model: "raspberrypi,5-model-b" },
      ],
    });

    const poller = createApDiscoveryPoller(prisma as any, openwrt);
    await poller.pollOnce();

    const row = prisma.rows.get("B8:27:EB:00:00:01");
    // Status unchanged — re-discovery of an ONLINE AP must not move it
    // back into AWAITING_APPROVAL.
    expect(row.status).toBe("ONLINE");
    expect(row.lastSeen.getTime()).toBeGreaterThan(baseline.getTime());
  });
});
