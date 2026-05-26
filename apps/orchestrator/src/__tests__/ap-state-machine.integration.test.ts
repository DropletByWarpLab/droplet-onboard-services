/**
 * WARP-446 — full AP state-machine integration test.
 *
 * Drives the orchestrator's `ap-onboard.service.ts` through:
 *   reconcileDiscovered  → AWAITING_APPROVAL
 *   approveAp            → PROVISIONING → ONLINE (+ audit columns)
 *   decommissionAp       → DECOMMISSIONED
 *
 * The routing-service hop is mocked at the `openwrt.client.ts` boundary
 * (same pattern as `aps.test.ts`), so this test runs without any real
 * Python service. The point of having a SEPARATE integration test on
 * top of the per-route unit tests is that the state machine has
 * order-dependent assertions (PROVISIONING is written BEFORE the
 * routing call so the dashboard polling read sees "spinning"; FAILED
 * captures failureReason; idempotent re-runs collapse) — those
 * assertions don't fit cleanly in a single route's unit test.
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
  const actual = await vi.importActual<typeof import("../services/openwrt.client.js")>(
    "../services/openwrt.client.js",
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
  ApOnboardError,
} from "../services/ap-onboard.service.js";
import * as openwrt from "../services/openwrt.client.js";

// In-memory Prisma stand-in for ApDevice. Tracks the order of update
// calls so the test can assert the PROVISIONING-then-ONLINE walk
// rather than just the terminal state.
function createPrismaMock() {
  const rows = new Map<string, any>();
  const updateLog: Array<{ mac: string; status: string }> = [];
  return {
    rows,
    updateLog,
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
        if (typeof data.status === "string") {
          updateLog.push({ mac: where.mac, status: data.status });
        }
        return merged;
      }),
      // Used by the ADR-005 LRU eviction in reconcileDiscovered.
      count: vi.fn(async ({ where }: any = {}) => {
        const statusIn: string[] | undefined = where?.status?.in;
        let n = 0;
        for (const row of rows.values()) {
          if (!statusIn || statusIn.includes(row.status)) n += 1;
        }
        return n;
      }),
      findMany: vi.fn(async ({ where, orderBy, take, select }: any = {}) => {
        const statusIn: string[] | undefined = where?.status?.in;
        let list = Array.from(rows.values()).filter((row) =>
          !statusIn || statusIn.includes(row.status),
        );
        if (orderBy?.lastSeen === "asc") {
          list.sort((a, b) => new Date(a.lastSeen).getTime() - new Date(b.lastSeen).getTime());
        } else if (orderBy?.lastSeen === "desc") {
          list.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
        }
        if (typeof take === "number") list = list.slice(0, take);
        if (select) {
          return list.map((row) => {
            const out: any = {};
            for (const key of Object.keys(select)) {
              if (select[key]) out[key] = row[key];
            }
            return out;
          });
        }
        return list;
      }),
      deleteMany: vi.fn(async ({ where }: any = {}) => {
        const macsIn: string[] | undefined = where?.mac?.in;
        if (!macsIn) return { count: 0 };
        let count = 0;
        for (const mac of macsIn) {
          if (rows.delete(mac)) count += 1;
        }
        return { count };
      }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AP state machine — full lifecycle (WARP-446 integration)", () => {
  it("walks a single AP through DISCOVERED → AWAITING_APPROVAL → PROVISIONING → ONLINE → DECOMMISSIONED", async () => {
    const prisma = createPrismaMock();

    // 1. Discovery poller observes a fresh announce.
    const result1 = await reconcileDiscovered(prisma as any, [
      {
        mac: "B8:27:EB:12:34:56",
        model: "raspberrypi,5-model-b",
        version: "1.0",
        lastIp: "192.168.50.42",
      },
    ]);
    expect(result1.created).toBe(1);
    expect(prisma.rows.get("B8:27:EB:12:34:56")?.status).toBe("AWAITING_APPROVAL");

    // 2. Re-observation of the same MAC bumps lastSeen but does NOT
    //    re-transition status.
    const result2 = await reconcileDiscovered(prisma as any, [
      { mac: "B8:27:EB:12:34:56", model: "raspberrypi,5-model-b" },
    ]);
    expect(result2.updated).toBe(1);
    expect(prisma.rows.get("B8:27:EB:12:34:56")?.status).toBe("AWAITING_APPROVAL");

    // 3. Operator hits Approve. The state walk must be
    //    PROVISIONING-then-ONLINE so the dashboard's polling read sees
    //    the spinning state before the success state.
    (openwrt.approveAp as any).mockResolvedValue({
      status: "ok",
      mac: "B8:27:EB:12:34:56",
      iface_section: "ap_extender_b827eb123456",
      ssid: "Droplet",
      operation_id: "op-abc",
    });
    await approveAp(
      prisma as any,
      "B8:27:EB:12:34:56",
      { ssid: "Droplet", encryptionKey: "longenoughpw" },
      { username: "stefan" },
    );
    const provisioningTransitions = prisma.updateLog
      .filter((u) => u.mac === "B8:27:EB:12:34:56")
      .map((u) => u.status);
    expect(provisioningTransitions).toContain("PROVISIONING");
    expect(provisioningTransitions[provisioningTransitions.length - 1]).toBe("ONLINE");

    // Audit columns populated on the ONLINE row.
    const row = prisma.rows.get("B8:27:EB:12:34:56");
    expect(row.status).toBe("ONLINE");
    expect(row.approvedBy).toBe("stefan");
    expect(row.approvedAt).toBeInstanceOf(Date);
    expect(row.approvedSsid).toBe("Droplet");
    expect(row.lastOperationId).toBe("op-abc");

    // 4. Decommission.
    (openwrt.decommissionAp as any).mockResolvedValue({
      status: "ok",
      mac: "B8:27:EB:12:34:56",
      operation_id: "op-decom",
    });
    await decommissionAp(prisma as any, "B8:27:EB:12:34:56");
    const decommissionedRow = prisma.rows.get("B8:27:EB:12:34:56");
    expect(decommissionedRow.status).toBe("DECOMMISSIONED");
    expect(decommissionedRow.decommissionedAt).toBeInstanceOf(Date);
    expect(decommissionedRow.lastOperationId).toBe("op-decom");

    // 5. Re-decommission is a no-op (idempotent).
    (openwrt.decommissionAp as any).mockClear();
    await decommissionAp(prisma as any, "B8:27:EB:12:34:56");
    expect(openwrt.decommissionAp).not.toHaveBeenCalled();
  });

  it("transitions to FAILED with failureReason when the router call errors mid-approve", async () => {
    const prisma = createPrismaMock();
    await reconcileDiscovered(prisma as any, [
      { mac: "B8:27:EB:00:00:01", model: "raspberrypi,5-model-b" },
    ]);
    (openwrt.approveAp as any).mockRejectedValue(
      Object.assign(new Error("Router unreachable"), { name: "Error" }),
    );

    await expect(
      approveAp(
        prisma as any,
        "B8:27:EB:00:00:01",
        { ssid: "Droplet", encryptionKey: "longenoughpw" },
        { username: "stefan" },
      ),
    ).rejects.toBeInstanceOf(ApOnboardError);

    const row = prisma.rows.get("B8:27:EB:00:00:01");
    expect(row.status).toBe("FAILED");
    expect(row.failureReason).toMatch(/Router unreachable/);
    // PROVISIONING was reached transiently before FAILED.
    const updates = prisma.updateLog.filter((u) => u.mac === "B8:27:EB:00:00:01");
    expect(updates.map((u) => u.status)).toEqual(["PROVISIONING", "FAILED"]);
  });

  it("reconciler does NOT auto-resurrect a DECOMMISSIONED AP from fresh discovery", async () => {
    const prisma = createPrismaMock();
    // Seed a DECOMMISSIONED row.
    prisma.rows.set("B8:27:EB:00:00:01", {
      mac: "B8:27:EB:00:00:01",
      status: "DECOMMISSIONED",
      decommissionedAt: new Date(100),
      lastSeen: new Date(100),
    });
    await reconcileDiscovered(prisma as any, [
      { mac: "B8:27:EB:00:00:01", model: "raspberrypi,5-model-b" },
    ]);
    const row = prisma.rows.get("B8:27:EB:00:00:01");
    expect(row.status).toBe("DECOMMISSIONED"); // not flipped back
    expect(row.model).toBe("raspberrypi,5-model-b"); // metadata still updated
  });

  it("evicts oldest DISCOVERED/AWAITING_APPROVAL rows to honor ADR-005 LRU cap of 25", async () => {
    const prisma = createPrismaMock();
    // Seed 25 AWAITING_APPROVAL rows so the cap is exactly hit.
    // lastSeen incrementing so row 0 is oldest, row 24 is youngest.
    for (let i = 0; i < 25; i += 1) {
      const mac = `AA:BB:CC:00:00:${i.toString(16).padStart(2, "0").toUpperCase()}`;
      prisma.rows.set(mac, {
        mac,
        status: "AWAITING_APPROVAL",
        lastSeen: new Date(1_000_000 + i * 1000),
      });
    }
    // Also seed one ONLINE row — must be EXEMPT from eviction even
    // though it would be the absolute oldest entry overall.
    prisma.rows.set("ZZ:ZZ:ZZ:00:00:01", {
      mac: "ZZ:ZZ:ZZ:00:00:01",
      status: "ONLINE",
      lastSeen: new Date(0), // older than everything
    });

    // 3 fresh observations push the awaiting count to 28 → 3 evictions.
    await reconcileDiscovered(prisma as any, [
      { mac: "DE:AD:BE:EF:00:01" },
      { mac: "DE:AD:BE:EF:00:02" },
      { mac: "DE:AD:BE:EF:00:03" },
    ]);

    const awaiting = Array.from(prisma.rows.values()).filter(
      (r) => r.status === "AWAITING_APPROVAL",
    );
    expect(awaiting.length).toBe(25);

    // ONLINE row survives despite being the oldest by lastSeen.
    expect(prisma.rows.get("ZZ:ZZ:ZZ:00:00:01")?.status).toBe("ONLINE");

    // The 3 youngest of the original 25 (idx 22-24) should still be
    // present; the 3 oldest (idx 0-2) should be gone; the 3 new MACs
    // should be present.
    expect(prisma.rows.has("AA:BB:CC:00:00:00")).toBe(false);
    expect(prisma.rows.has("AA:BB:CC:00:00:01")).toBe(false);
    expect(prisma.rows.has("AA:BB:CC:00:00:02")).toBe(false);
    expect(prisma.rows.has("AA:BB:CC:00:00:18")).toBe(true); // idx 24
    expect(prisma.rows.has("DE:AD:BE:EF:00:01")).toBe(true);
    expect(prisma.rows.has("DE:AD:BE:EF:00:02")).toBe(true);
    expect(prisma.rows.has("DE:AD:BE:EF:00:03")).toBe(true);
  });

  it("evicted count surfaces in reconcileDiscovered return value", async () => {
    const prisma = createPrismaMock();
    for (let i = 0; i < 26; i += 1) {
      const mac = `AA:BB:CC:00:01:${i.toString(16).padStart(2, "0").toUpperCase()}`;
      prisma.rows.set(mac, {
        mac,
        status: "AWAITING_APPROVAL",
        lastSeen: new Date(2_000_000 + i * 1000),
      });
    }
    // Re-observe one existing row; no new rows. Eviction should still
    // run and trim the over-count.
    const result = await reconcileDiscovered(prisma as any, [
      { mac: "AA:BB:CC:00:01:19" },
    ]);
    expect(result.evicted).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
  });

  it("normalizeMac() canonicalises every ingress variant — full machine still keys on uppercase-colon form", async () => {
    const prisma = createPrismaMock();
    // Dash-separated lowercase observed first.
    await reconcileDiscovered(prisma as any, [
      { mac: "b8-27-eb-00-00-01" },
    ]);
    // Compact-form re-observed.
    await reconcileDiscovered(prisma as any, [
      { mac: "B827EB000001" },
    ]);
    // Both should resolve to the same canonical key.
    expect(prisma.rows.size).toBe(1);
    expect(prisma.rows.get("B8:27:EB:00:00:01")?.status).toBe("AWAITING_APPROVAL");
  });
});
