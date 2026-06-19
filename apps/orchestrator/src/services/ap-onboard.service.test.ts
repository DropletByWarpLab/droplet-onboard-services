/**
 * ADR-024 Phase 1 — backend-dispatch contract for ap-onboard.service.
 *
 * Phase 1 is a pure, behavior-preserving refactor: the existing ADR-005
 * logic moves behind a `DropletImageBackend`, and `reconcileDiscovered`
 * / `approveAp` / `decommissionAp` become thin routers that select a
 * handler by the row's `backend` column (defaulting to DROPLET_IMAGE).
 *
 * These tests pin the two new invariants the refactor introduces:
 *   (a) a freshly reconciled row is created with backend = DROPLET_IMAGE
 *       (today's only discovery source); and
 *   (b) approveAp / decommissionAp dispatch through the registry to the
 *       DropletImageBackend for such rows.
 *
 * Everything else (state walk, audit columns, LRU eviction, FAILED
 * capture, idempotent decommission) is the unchanged ADR-005 behavior
 * guarded by ap-state-machine.integration.test.ts + aps.test.ts.
 *
 * Same mocking shape as ap-state-machine.integration.test.ts: config +
 * the openwrt.client routing hop are mocked; an in-memory Prisma
 * stand-in backs the ApDevice table.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    ROUTING_SERVICE_URL: "http://routing.test",
    ROUTING_SERVICE_TOKEN: "test-token",
    ROUTING_MODE: "mock",
    DROPLET_AP_DISCOVERY_INTERVAL: 10,
    DROPLET_AP_APPROVAL_TIMEOUT: 60,
    DROPLET_AP_DAWN_ENABLED: true,
    DROPLET_AP_DEFAULT_TXPOWER: 20,
  },
}));

vi.mock("../services/openwrt.client.js", async () => {
  const actual = await vi.importActual<typeof import("./openwrt.client.js")>(
    "./openwrt.client.js",
  );
  return {
    ...actual,
    approveAp: vi.fn(),
    decommissionAp: vi.fn(),
  };
});

import {
  reconcileDiscovered,
  approveAp,
  decommissionAp,
  evictDiscoveredAps,
  AP_ONBOARD_BACKENDS,
  DROPLET_IMAGE_BACKEND,
  DISCOVERED_AP_LRU_CAP,
  resolveApBackend,
} from "./ap-onboard.service.js";
import * as openwrt from "./openwrt.client.js";

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
      count: vi.fn(async ({ where }: any = {}) => {
        const statusIn: string[] | undefined = where?.status?.in;
        let n = 0;
        for (const row of rows.values()) {
          if (!statusIn || statusIn.includes(row.status)) n += 1;
        }
        return n;
      }),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ap-onboard backend registry (ADR-024 Phase 1)", () => {
  it("registers exactly the three ADR-024 backends, with DROPLET_IMAGE the live one", () => {
    expect(Object.keys(AP_ONBOARD_BACKENDS).sort()).toEqual([
      "DROPLET_IMAGE",
      "EASYMESH",
      "UNIFI",
    ]);
    expect(AP_ONBOARD_BACKENDS.DROPLET_IMAGE).toBe(DROPLET_IMAGE_BACKEND);
  });

  it("EASYMESH + UNIFI handlers are NotImplemented stubs this phase (registry shape is real, no behavior added)", async () => {
    const prisma = createPrismaMock();
    await expect(
      AP_ONBOARD_BACKENDS.EASYMESH.reconcile(prisma as any, []),
    ).rejects.toThrow(/not implemented/i);
    await expect(
      AP_ONBOARD_BACKENDS.UNIFI.approve(
        prisma as any,
        "AA:BB:CC:DD:EE:FF",
        { ssid: "x", encryptionKey: "longenoughpw" },
        { username: "stefan" },
      ),
    ).rejects.toThrow(/not implemented/i);
  });

  it("resolveApBackend defaults a null/undefined/unknown backend to DROPLET_IMAGE (no state-from-absence)", () => {
    expect(resolveApBackend(undefined)).toBe(DROPLET_IMAGE_BACKEND);
    expect(resolveApBackend(null as any)).toBe(DROPLET_IMAGE_BACKEND);
    expect(resolveApBackend("DROPLET_IMAGE")).toBe(DROPLET_IMAGE_BACKEND);
    expect(resolveApBackend("EASYMESH")).toBe(AP_ONBOARD_BACKENDS.EASYMESH);
  });
});

describe("reconcileDiscovered → backend defaulting (ADR-024 Phase 1 AC)", () => {
  it("creates a freshly discovered row with backend = DROPLET_IMAGE", async () => {
    const prisma = createPrismaMock();
    await reconcileDiscovered(prisma as any, [
      { mac: "B8:27:EB:AA:BB:CC", model: "raspberrypi,5-model-b" },
    ]);
    const row = prisma.rows.get("B8:27:EB:AA:BB:CC");
    expect(row.status).toBe("AWAITING_APPROVAL");
    expect(row.backend).toBe("DROPLET_IMAGE");
  });
});

describe("reconcileDiscovered → per-observation backend tag (ADR-024 Phase 2 AC)", () => {
  it("creates a row with backend = EASYMESH when the observation is tagged EASYMESH", async () => {
    const prisma = createPrismaMock();
    // The create path must honor the EXPLICIT obs.backend, replacing the
    // Phase-1 hardcoded DROPLET_IMAGE. Discovery is multiplexed now, so a
    // single reconcile pass can carry observations from more than one source.
    await reconcileDiscovered(prisma as any, [
      { mac: "AA:BB:CC:DD:EE:01", backend: "EASYMESH", vendor: "TP-Link" },
    ]);
    const row = prisma.rows.get("AA:BB:CC:DD:EE:01");
    expect(row.status).toBe("AWAITING_APPROVAL");
    expect(row.backend).toBe("EASYMESH");
  });

  it("an observation with no backend tag still defaults to DROPLET_IMAGE (back-compat with the mDNS source)", async () => {
    const prisma = createPrismaMock();
    await reconcileDiscovered(prisma as any, [{ mac: "B8:27:EB:00:00:09" }]);
    expect(prisma.rows.get("B8:27:EB:00:00:09").backend).toBe("DROPLET_IMAGE");
  });

  it("a mixed snapshot creates one row per backend in a single pass", async () => {
    const prisma = createPrismaMock();
    await reconcileDiscovered(prisma as any, [
      { mac: "B8:27:EB:00:00:10", backend: "DROPLET_IMAGE" },
      { mac: "AA:BB:CC:00:00:11", backend: "EASYMESH" },
    ]);
    expect(prisma.rows.get("B8:27:EB:00:00:10").backend).toBe("DROPLET_IMAGE");
    expect(prisma.rows.get("AA:BB:CC:00:00:11").backend).toBe("EASYMESH");
  });
});

describe("evictDiscoveredAps → LRU counts across ALL backends (ADR-024 Phase 2 AC #5)", () => {
  // A richer in-memory mock that actually implements the count / findMany /
  // deleteMany shapes evictDiscoveredAps uses, so we can assert the cap
  // bounds the operator-actionable surface regardless of which backend
  // discovered each row.
  function createEvictionPrismaMock() {
    const rows = new Map<string, any>();
    return {
      rows,
      apDevice: {
        count: vi.fn(async ({ where }: any = {}) => {
          const statusIn: string[] | undefined = where?.status?.in;
          let n = 0;
          for (const row of rows.values()) {
            if (!statusIn || statusIn.includes(row.status)) n += 1;
          }
          return n;
        }),
        findMany: vi.fn(async ({ where, orderBy, take }: any = {}) => {
          const statusIn: string[] | undefined = where?.status?.in;
          let list = [...rows.values()].filter(
            (r) => !statusIn || statusIn.includes(r.status),
          );
          if (orderBy?.lastSeen === "asc") {
            list = list.sort(
              (a, b) => a.lastSeen.getTime() - b.lastSeen.getTime(),
            );
          }
          if (typeof take === "number") list = list.slice(0, take);
          return list.map((r) => ({ mac: r.mac }));
        }),
        deleteMany: vi.fn(async ({ where }: any) => {
          const macs: string[] = where?.mac?.in ?? [];
          let count = 0;
          for (const mac of macs) {
            if (rows.delete(mac)) count += 1;
          }
          return { count };
        }),
      },
    };
  }

  it("counts AWAITING_APPROVAL + DISCOVERED across DROPLET_IMAGE AND EASYMESH rows when enforcing the cap", async () => {
    const prisma = createEvictionPrismaMock();
    // Seed CAP+5 actionable rows split across two backends — the eviction
    // must treat them as one pool (the cap is a per-box budget on the
    // operator-actionable surface, not a per-backend budget).
    const total = DISCOVERED_AP_LRU_CAP + 5;
    for (let i = 0; i < total; i += 1) {
      const mac = `AA:BB:CC:00:${(i >> 8).toString(16).padStart(2, "0")}:${(i & 0xff).toString(16).padStart(2, "0")}`.toUpperCase();
      prisma.rows.set(mac, {
        mac,
        status: i % 2 === 0 ? "AWAITING_APPROVAL" : "DISCOVERED",
        // Alternate the backend so neither one alone exceeds the cap, but
        // together they do — proves the count is cross-backend.
        backend: i % 3 === 0 ? "EASYMESH" : "DROPLET_IMAGE",
        lastSeen: new Date(i),
      });
    }

    const evicted = await evictDiscoveredAps(prisma as any);

    // 5 over the cap → 5 evicted, leaving exactly the cap.
    expect(evicted).toBe(5);
    expect(prisma.rows.size).toBe(DISCOVERED_AP_LRU_CAP);
    // The 5 oldest (lowest lastSeen) went, regardless of backend.
    expect(prisma.rows.has("AA:BB:CC:00:00:00")).toBe(false);
  });
});

describe("approveAp / decommissionAp → DropletImageBackend dispatch (ADR-024 Phase 1 AC)", () => {
  it("dispatches approve through the DropletImageBackend for a DROPLET_IMAGE row", async () => {
    const prisma = createPrismaMock();
    await reconcileDiscovered(prisma as any, [{ mac: "B8:27:EB:00:00:01" }]);

    (openwrt.approveAp as any).mockResolvedValue({
      status: "ok",
      mac: "B8:27:EB:00:00:01",
      operation_id: "op-1",
    });
    const approveSpy = vi.spyOn(DROPLET_IMAGE_BACKEND, "approve");

    const result = await approveAp(
      prisma as any,
      "B8:27:EB:00:00:01",
      { ssid: "Droplet", encryptionKey: "longenoughpw" },
      { username: "stefan" },
    );

    // The router delegated to the DropletImageBackend handler...
    expect(approveSpy).toHaveBeenCalledTimes(1);
    // ...which ran the unchanged ADR-005 routing push.
    expect(openwrt.approveAp).toHaveBeenCalledTimes(1);
    expect(result.operationId).toBe("op-1");
    expect((result.ap as any).status).toBe("ONLINE");
    approveSpy.mockRestore();
  });

  it("dispatches decommission through the DropletImageBackend for a DROPLET_IMAGE row", async () => {
    const prisma = createPrismaMock();
    prisma.rows.set("B8:27:EB:00:00:02", {
      mac: "B8:27:EB:00:00:02",
      status: "ONLINE",
      backend: "DROPLET_IMAGE",
      lastSeen: new Date(),
    });
    (openwrt.decommissionAp as any).mockResolvedValue({
      status: "ok",
      mac: "B8:27:EB:00:00:02",
      operation_id: "op-decom",
    });
    const decomSpy = vi.spyOn(DROPLET_IMAGE_BACKEND, "decommission");

    const result = await decommissionAp(prisma as any, "B8:27:EB:00:00:02");

    expect(decomSpy).toHaveBeenCalledTimes(1);
    expect(openwrt.decommissionAp).toHaveBeenCalledTimes(1);
    expect((result.ap as any).status).toBe("DECOMMISSIONED");
    decomSpy.mockRestore();
  });

  it("a row with no backend column (legacy / pre-migration seed) still dispatches to DropletImageBackend", async () => {
    const prisma = createPrismaMock();
    // No `backend` field — mirrors rows seeded before the ADR-024 column
    // existed. The router must default it, not crash or skip dispatch.
    prisma.rows.set("B8:27:EB:00:00:03", {
      mac: "B8:27:EB:00:00:03",
      status: "ONLINE",
      lastSeen: new Date(),
    });
    (openwrt.decommissionAp as any).mockResolvedValue({
      status: "ok",
      mac: "B8:27:EB:00:00:03",
      operation_id: "op-legacy",
    });
    const decomSpy = vi.spyOn(DROPLET_IMAGE_BACKEND, "decommission");

    const result = await decommissionAp(prisma as any, "B8:27:EB:00:00:03");

    expect(decomSpy).toHaveBeenCalledTimes(1);
    expect((result.ap as any).status).toBe("DECOMMISSIONED");
    decomSpy.mockRestore();
  });
});
