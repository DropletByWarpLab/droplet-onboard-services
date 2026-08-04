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
    agentMaxIter: { defaultIter: 5, capIter: 10 },
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
    // WARP-1712: the AP-wireless hop the household Wi-Fi surface fans over.
    getApWireless: vi.fn(),
    setApWireless: vi.fn(),
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
  createUniFiBackend,
  createEasyMeshBackend,
  getApWifi,
  setApWifi,
  getApWirelessForMac,
  ApOnboardError,
} from "./ap-onboard.service.js";
import * as openwrt from "./openwrt.client.js";
import type { UniFiNetworkClient } from "./unifi-network.client.js";
import type { EasyMeshControllerClient } from "./easymesh-controller.client.js";

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

  it("EASYMESH and UNIFI are both real handlers now (Phase 4 / Phase 3 replaced their stubs)", async () => {
    const prisma = createPrismaMock();
    // Phase 4 replaced the EASYMESH stub: its reconcile is the shared upsert
    // path, so an empty snapshot resolves cleanly rather than throwing
    // 'not implemented'.
    await expect(
      AP_ONBOARD_BACKENDS.EASYMESH.reconcile(prisma as any, []),
    ).resolves.toBeDefined();
    // UNIFI is the real Phase-3 handler (same shared reconcile).
    await expect(
      AP_ONBOARD_BACKENDS.UNIFI.reconcile(prisma as any, []),
    ).resolves.toBeDefined();
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

// ─────────────────────────────────────────────────────────────────────────
// ADR-024 Phase 3 — UNIFI backend handler (official-API adopt + WLAN push).
//
// The handler drives a UniFiNetworkClient (mocked here — there is no real
// controller on the laptop) and must mirror the DROPLET_IMAGE handler's
// transition + audit discipline EXACTLY: PROVISIONING → ONLINE on success
// (audit columns written), PROVISIONING → FAILED + failureReason on any
// client error (no partial ONLINE), and forget → DECOMMISSIONED.
// ─────────────────────────────────────────────────────────────────────────

function fakeUniFiClient(
  overrides: Partial<Record<keyof UniFiNetworkClient, any>> = {},
): UniFiNetworkClient {
  return {
    listPendingDevices: vi.fn(async () => []),
    adoptDevice: vi.fn(async () => ({ deviceId: "u-dev-1" })),
    pushWlanConfig: vi.fn(async () => undefined),
    getDeviceStatus: vi.fn(async () => ({ mac: "x", state: "connected" })),
    forgetDevice: vi.fn(async () => undefined),
    ...overrides,
  } as UniFiNetworkClient;
}

describe("UNIFI backend handler (ADR-024 Phase 3)", () => {
  const MAC = "AA:BB:CC:DD:EE:01";

  function seedUnifiRow(prisma: ReturnType<typeof createPrismaMock>, status = "AWAITING_APPROVAL") {
    prisma.rows.set(MAC, {
      mac: MAC,
      status,
      backend: "UNIFI",
      vendor: "Ubiquiti",
      backendRef: "u-dev-1",
      lastSeen: new Date(),
    });
  }

  it("approve adopts then pushes WLAN, driving PROVISIONING → ONLINE with audit columns written", async () => {
    const prisma = createPrismaMock();
    seedUnifiRow(prisma);
    const client = fakeUniFiClient();
    const backend = createUniFiBackend(client);

    const result = await backend.approve(
      prisma as any,
      MAC,
      { ssid: "Droplet", encryptionKey: "longenoughpw" },
      { username: "stefan" },
    );

    // adopt BEFORE push (order matters — can't configure an unadopted device)
    expect(client.adoptDevice).toHaveBeenCalledTimes(1);
    expect(client.pushWlanConfig).toHaveBeenCalledTimes(1);
    const adoptOrder = (client.adoptDevice as any).mock.invocationCallOrder[0];
    const pushOrder = (client.pushWlanConfig as any).mock.invocationCallOrder[0];
    expect(adoptOrder).toBeLessThan(pushOrder);

    const row = prisma.rows.get(MAC);
    expect(row.status).toBe("ONLINE");
    expect(row.approvedBy).toBe("stefan");
    expect(row.approvedSsid).toBe("Droplet");
    expect(row.approvedAt).toBeInstanceOf(Date);
    expect((result.ap as any).status).toBe("ONLINE");
  });

  it("approve transitions PROVISIONING → FAILED with failureReason when the client throws, no partial ONLINE", async () => {
    const prisma = createPrismaMock();
    seedUnifiRow(prisma);
    const client = fakeUniFiClient({
      adoptDevice: vi.fn(async () => {
        throw new Error("controller refused adoption");
      }),
      pushWlanConfig: vi.fn(async () => undefined),
    });
    const backend = createUniFiBackend(client);

    await expect(
      backend.approve(
        prisma as any,
        MAC,
        { ssid: "Droplet", encryptionKey: "longenoughpw" },
        { username: "stefan" },
      ),
    ).rejects.toThrow();

    // WLAN push never ran (adopt failed first) — no partial config left behind.
    expect(client.pushWlanConfig).not.toHaveBeenCalled();
    const row = prisma.rows.get(MAC);
    expect(row.status).toBe("FAILED");
    expect(row.failureReason).toContain("controller refused adoption");
    expect(row.approvedAt).toBeUndefined();
  });

  it("approve fails (FAILED) when adoption succeeds but the WLAN push throws", async () => {
    const prisma = createPrismaMock();
    seedUnifiRow(prisma);
    const client = fakeUniFiClient({
      pushWlanConfig: vi.fn(async () => {
        throw new Error("wlan push rejected");
      }),
    });
    const backend = createUniFiBackend(client);

    await expect(
      backend.approve(
        prisma as any,
        MAC,
        { ssid: "Droplet", encryptionKey: "longenoughpw" },
        { username: "stefan" },
      ),
    ).rejects.toThrow();

    expect(client.adoptDevice).toHaveBeenCalledTimes(1);
    const row = prisma.rows.get(MAC);
    expect(row.status).toBe("FAILED");
    expect(row.failureReason).toContain("wlan push rejected");
  });

  it("approve throws notFound when the MAC was never discovered", async () => {
    const prisma = createPrismaMock();
    const backend = createUniFiBackend(fakeUniFiClient());
    await expect(
      backend.approve(
        prisma as any,
        "AA:BB:CC:00:00:99",
        { ssid: "Droplet", encryptionKey: "longenoughpw" },
        { username: "stefan" },
      ),
    ).rejects.toThrow(/not found/i);
  });

  it("decommission forgets the device on the controller, driving → DECOMMISSIONED", async () => {
    const prisma = createPrismaMock();
    seedUnifiRow(prisma, "ONLINE");
    const client = fakeUniFiClient();
    const backend = createUniFiBackend(client);

    const result = await backend.decommission(prisma as any, MAC);

    expect(client.forgetDevice).toHaveBeenCalledTimes(1);
    expect(prisma.rows.get(MAC).status).toBe("DECOMMISSIONED");
    expect((result.ap as any).status).toBe("DECOMMISSIONED");
  });

  it("decommission is idempotent on an already-DECOMMISSIONED row (no forget re-fire)", async () => {
    const prisma = createPrismaMock();
    seedUnifiRow(prisma, "DECOMMISSIONED");
    const client = fakeUniFiClient();
    const backend = createUniFiBackend(client);

    const result = await backend.decommission(prisma as any, MAC);

    expect(client.forgetDevice).not.toHaveBeenCalled();
    expect((result.ap as any).status).toBe("DECOMMISSIONED");
  });

  it("reconcile upserts a UNIFI observation the same way the DROPLET_IMAGE path does", async () => {
    const prisma = createPrismaMock();
    const backend = createUniFiBackend(fakeUniFiClient());
    await backend.reconcile(prisma as any, [
      { mac: MAC, backend: "UNIFI", vendor: "Ubiquiti", backendRef: "u-dev-1", model: "U6-Lite" },
    ]);
    const row = prisma.rows.get(MAC);
    expect(row.status).toBe("AWAITING_APPROVAL");
    expect(row.backend).toBe("UNIFI");
    expect(row.backendRef).toBe("u-dev-1");
  });

  it("the registry dispatches a UNIFI row to the UniFi handler (DROPLET_IMAGE rows are unaffected)", async () => {
    const prisma = createPrismaMock();
    seedUnifiRow(prisma, "ONLINE");
    // The registry's UNIFI entry is the real handler this phase (not a stub).
    const unifiApproveStub = AP_ONBOARD_BACKENDS.UNIFI;
    expect(unifiApproveStub.key).toBe("UNIFI");

    // A UNIFI row routes through approveAp → the UNIFI handler. We assert the
    // dispatch reached the UNIFI handler by spying on it.
    const decomSpy = vi.spyOn(AP_ONBOARD_BACKENDS.UNIFI, "decommission");
    // The registry handler talks to a client built from (empty) config, which
    // would throw NOT_CONFIGURED — but the already-DECOMMISSIONED short-circuit
    // is reached only via the ONLINE path's forget. To keep this a pure
    // dispatch assertion, seed DECOMMISSIONED so no client call is needed.
    prisma.rows.set(MAC, { mac: MAC, status: "DECOMMISSIONED", backend: "UNIFI", lastSeen: new Date() });
    await decommissionAp(prisma as any, MAC);
    expect(decomSpy).toHaveBeenCalledTimes(1);
    decomSpy.mockRestore();
  });

  it("UNIFI is NO LONGER a NotImplemented stub (Phase 3 replaced it)", async () => {
    const prisma = createPrismaMock();
    // reconcile must NOT throw 'not implemented' anymore.
    await expect(
      AP_ONBOARD_BACKENDS.UNIFI.reconcile(prisma as any, []),
    ).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ADR-024 Phase 4 — EASYMESH backend handler (prplMesh Controller-only M1/M2).
//
// The handler drives an EasyMeshControllerClient (mocked here — there is no
// real controller on the laptop, and prplMesh-on-mt76 is the ADR's open
// hardware risk) and must mirror the DROPLET_IMAGE / UNIFI handler's
// transition + audit discipline EXACTLY: PROVISIONING → ONLINE on success
// (audit columns written), PROVISIONING → FAILED + failureReason on any client
// error (no partial ONLINE), and remove → DECOMMISSIONED. operationId is null
// (the controller is request/response — no routing-service op to poll).
// ─────────────────────────────────────────────────────────────────────────

function fakeEasyMeshClient(
  overrides: Partial<Record<keyof EasyMeshControllerClient, any>> = {},
): EasyMeshControllerClient {
  return {
    listOnboardingAgents: vi.fn(async () => []),
    onboardAgent: vi.fn(async () => undefined),
    getAgentStatus: vi.fn(async () => ({ alMac: "x", state: "onboarded" })),
    removeAgent: vi.fn(async () => undefined),
    ...overrides,
  } as EasyMeshControllerClient;
}

describe("EASYMESH backend handler (ADR-024 Phase 4)", () => {
  const MAC = "AA:BB:CC:DD:EE:01";

  function seedEasyMeshRow(
    prisma: ReturnType<typeof createPrismaMock>,
    status = "AWAITING_APPROVAL",
  ) {
    prisma.rows.set(MAC, {
      mac: MAC,
      status,
      backend: "EASYMESH",
      vendor: "TP-Link",
      backendRef: MAC,
      lastSeen: new Date(),
    });
  }

  it("approve onboards the Agent (M1/M2), driving PROVISIONING → ONLINE with audit columns written", async () => {
    const prisma = createPrismaMock();
    seedEasyMeshRow(prisma);
    const client = fakeEasyMeshClient();
    const backend = createEasyMeshBackend(client);

    const result = await backend.approve(
      prisma as any,
      MAC,
      { ssid: "Droplet", encryptionKey: "longenoughpw" },
      { username: "stefan" },
    );

    expect(client.onboardAgent).toHaveBeenCalledTimes(1);
    // The credentials carried the household SSID + key (M1/M2 push).
    const [alMac, creds] = (client.onboardAgent as any).mock.calls[0];
    expect(alMac).toBe(MAC);
    expect(creds).toMatchObject({ ssid: "Droplet", key: "longenoughpw" });

    const row = prisma.rows.get(MAC);
    expect(row.status).toBe("ONLINE");
    expect(row.approvedBy).toBe("stefan");
    expect(row.approvedSsid).toBe("Droplet");
    expect(row.approvedAt).toBeInstanceOf(Date);
    expect((result.ap as any).status).toBe("ONLINE");
    // Controller is request/response — no routing-service op to poll.
    expect(result.operationId).toBeNull();
  });

  it("approve transitions PROVISIONING → FAILED with failureReason when onboarding throws, no partial ONLINE", async () => {
    const prisma = createPrismaMock();
    seedEasyMeshRow(prisma);
    const client = fakeEasyMeshClient({
      onboardAgent: vi.fn(async () => {
        throw new Error("controller refused M2 credential push");
      }),
    });
    const backend = createEasyMeshBackend(client);

    await expect(
      backend.approve(
        prisma as any,
        MAC,
        { ssid: "Droplet", encryptionKey: "longenoughpw" },
        { username: "stefan" },
      ),
    ).rejects.toThrow();

    const row = prisma.rows.get(MAC);
    expect(row.status).toBe("FAILED");
    expect(row.failureReason).toContain("controller refused M2 credential push");
    // No audit columns written on the failure path — no partial ONLINE.
    expect(row.approvedAt).toBeUndefined();
  });

  it("approve throws notFound when the AL-MAC was never discovered", async () => {
    const prisma = createPrismaMock();
    const backend = createEasyMeshBackend(fakeEasyMeshClient());
    await expect(
      backend.approve(
        prisma as any,
        "AA:BB:CC:00:00:99",
        { ssid: "Droplet", encryptionKey: "longenoughpw" },
        { username: "stefan" },
      ),
    ).rejects.toThrow(/not found/i);
    // Never asked the controller to onboard a device we never saw.
    const backend2 = fakeEasyMeshClient();
    expect(backend2.onboardAgent).not.toHaveBeenCalled();
  });

  it("decommission removes the Agent on the controller, driving → DECOMMISSIONED", async () => {
    const prisma = createPrismaMock();
    seedEasyMeshRow(prisma, "ONLINE");
    const client = fakeEasyMeshClient();
    const backend = createEasyMeshBackend(client);

    const result = await backend.decommission(prisma as any, MAC);

    expect(client.removeAgent).toHaveBeenCalledTimes(1);
    expect(prisma.rows.get(MAC).status).toBe("DECOMMISSIONED");
    expect((result.ap as any).status).toBe("DECOMMISSIONED");
    expect(result.operationId).toBeNull();
  });

  it("decommission is idempotent on an already-DECOMMISSIONED row (no remove re-fire)", async () => {
    const prisma = createPrismaMock();
    seedEasyMeshRow(prisma, "DECOMMISSIONED");
    const client = fakeEasyMeshClient();
    const backend = createEasyMeshBackend(client);

    const result = await backend.decommission(prisma as any, MAC);

    expect(client.removeAgent).not.toHaveBeenCalled();
    expect((result.ap as any).status).toBe("DECOMMISSIONED");
  });

  it("reconcile upserts an EASYMESH observation the same way the other backends do", async () => {
    const prisma = createPrismaMock();
    const backend = createEasyMeshBackend(fakeEasyMeshClient());
    await backend.reconcile(prisma as any, [
      {
        mac: MAC,
        backend: "EASYMESH",
        vendor: "TP-Link",
        backendRef: MAC,
        model: "RE700X",
      },
    ]);
    const row = prisma.rows.get(MAC);
    expect(row.status).toBe("AWAITING_APPROVAL");
    expect(row.backend).toBe("EASYMESH");
    expect(row.backendRef).toBe(MAC);
  });

  it("the registry dispatches an EASYMESH row to the EasyMesh handler (others unaffected)", async () => {
    const prisma = createPrismaMock();
    // The registry's EASYMESH entry is the real handler this phase (not a stub).
    expect(AP_ONBOARD_BACKENDS.EASYMESH.key).toBe("EASYMESH");

    const decomSpy = vi.spyOn(AP_ONBOARD_BACKENDS.EASYMESH, "decommission");
    // Seed DECOMMISSIONED so the idempotent short-circuit is reached without
    // needing a (NOT_CONFIGURED) client call — a pure dispatch assertion.
    prisma.rows.set(MAC, {
      mac: MAC,
      status: "DECOMMISSIONED",
      backend: "EASYMESH",
      lastSeen: new Date(),
    });
    await decommissionAp(prisma as any, MAC);
    expect(decomSpy).toHaveBeenCalledTimes(1);
    decomSpy.mockRestore();
  });
});

/**
 * WARP-1712 — the household AP Wi-Fi surface.
 *
 * ONE SOURCE OF TRUTH: these functions hold no cached SSID. Every read fans
 * out to the AP(s) over the routing hop, so the Network tab's Wi-Fi form and
 * the Coverage Extenders card can never drift apart or from the hardware.
 * The fan-out is scoped by the EXPLICIT `backend` column — a UniFi AP manages
 * its own SSID on its own controller and must never be written here.
 */
describe("AP Wi-Fi household surface (WARP-1712)", () => {
  const MAC_A = "AA:BB:CC:DD:EE:01";
  const MAC_B = "AA:BB:CC:DD:EE:02";

  const getApWireless = vi.mocked(openwrt.getApWireless);
  const setApWireless = vi.mocked(openwrt.setApWireless);

  function state(overrides: Partial<openwrt.ApWireless> = {}): openwrt.ApWireless {
    return {
      supported: true,
      ssid: "Droplet",
      key: "per-unit-psk",
      encryption: "psk2+ccmp",
      band_steering: true,
      five_ghz_ssid: "Droplet",
      primary_section: "default_radio0",
      radios: [],
      ...overrides,
    };
  }

  /** Prisma stand-in whose findMany honours the status+backend filter. */
  function prismaWithAps(aps: { mac: string; status: string; backend: string }[]) {
    const prisma = createPrismaMock();
    for (const ap of aps) prisma.rows.set(ap.mac, { ...ap, lastSeen: new Date() });
    prisma.apDevice.findMany = vi.fn(async ({ where }: any = {}) =>
      Array.from(prisma.rows.values()).filter(
        (r: any) =>
          (!where?.status || r.status === where.status) &&
          (!where?.backend || r.backend === where.backend),
      ),
    ) as unknown as typeof prisma.apDevice.findMany;
    return prisma;
  }

  describe("getApWifi", () => {
    it("is honestly unsupported with no ONLINE Droplet AP — never an error", async () => {
      const prisma = prismaWithAps([]);
      await expect(getApWifi(prisma as any)).resolves.toMatchObject({
        supported: false, ssid: null, apCount: 0,
      });
      expect(getApWireless).not.toHaveBeenCalled();
    });

    it("reads live off the AP rather than any stored column", async () => {
      const prisma = prismaWithAps([
        { mac: MAC_A, status: "ONLINE", backend: "DROPLET_IMAGE" },
      ]);
      // A stale approval-time audit value that must NOT leak into the answer.
      (prisma.rows.get(MAC_A) as any).approvedSsid = "STALE-NAME";
      getApWireless.mockResolvedValue(state({ ssid: "Living Room" }));

      const result = await getApWifi(prisma as any);
      expect(getApWireless).toHaveBeenCalledWith({ mac: MAC_A });
      expect(result.ssid).toBe("Living Room");
      expect(result.key).toBe("per-unit-psk");
      expect(result.apCount).toBe(1);
      expect(result.inSync).toBe(true);
    });

    it("excludes non-Droplet backends from the fan-out", async () => {
      const prisma = prismaWithAps([
        { mac: MAC_A, status: "ONLINE", backend: "UNIFI" },
      ]);
      await expect(getApWifi(prisma as any)).resolves.toMatchObject({ supported: false });
      expect(getApWireless).not.toHaveBeenCalled();
    });

    it("excludes APs that are not ONLINE", async () => {
      const prisma = prismaWithAps([
        { mac: MAC_A, status: "AWAITING_APPROVAL", backend: "DROPLET_IMAGE" },
      ]);
      await expect(getApWifi(prisma as any)).resolves.toMatchObject({ supported: false });
      expect(getApWireless).not.toHaveBeenCalled();
    });

    it("reports a split household instead of picking a winner", async () => {
      const prisma = prismaWithAps([
        { mac: MAC_A, status: "ONLINE", backend: "DROPLET_IMAGE" },
        { mac: MAC_B, status: "ONLINE", backend: "DROPLET_IMAGE" },
      ]);
      getApWireless
        .mockResolvedValueOnce(state({ ssid: "Upstairs" }))
        .mockResolvedValueOnce(state({ ssid: "Downstairs" }));

      const result = await getApWifi(prisma as any);
      expect(result.inSync).toBe(false);
      // A form pre-filled with one AP's name would silently overwrite the other.
      expect(result.ssid).toBeNull();
      expect(result.key).toBeNull();
      expect(result.apCount).toBe(2);
    });

    it("reports band steering as null when any AP predates the substrate", async () => {
      const prisma = prismaWithAps([
        { mac: MAC_A, status: "ONLINE", backend: "DROPLET_IMAGE" },
        { mac: MAC_B, status: "ONLINE", backend: "DROPLET_IMAGE" },
      ]);
      getApWireless
        .mockResolvedValueOnce(state())
        .mockResolvedValueOnce(state({ band_steering: null }));
      await expect(getApWifi(prisma as any)).resolves.toMatchObject({
        bandSteering: null,
      });
    });

    it("is unsupported when the AP answers but cannot report wireless", async () => {
      const prisma = prismaWithAps([
        { mac: MAC_A, status: "ONLINE", backend: "DROPLET_IMAGE" },
      ]);
      getApWireless.mockResolvedValue({ supported: false, radios: [] });
      await expect(getApWifi(prisma as any)).resolves.toMatchObject({ supported: false });
    });

    it("wraps a routing failure as an ApOnboardError", async () => {
      const prisma = prismaWithAps([
        { mac: MAC_A, status: "ONLINE", backend: "DROPLET_IMAGE" },
      ]);
      getApWireless.mockRejectedValue(new Error("routing exploded"));
      await expect(getApWifi(prisma as any)).rejects.toBeInstanceOf(ApOnboardError);
    });
  });

  describe("setApWifi", () => {
    it("fans the write across every ONLINE Droplet AP", async () => {
      const prisma = prismaWithAps([
        { mac: MAC_A, status: "ONLINE", backend: "DROPLET_IMAGE" },
        { mac: MAC_B, status: "ONLINE", backend: "DROPLET_IMAGE" },
      ]);
      getApWireless.mockResolvedValue(state());
      setApWireless.mockResolvedValue({
        operationId: "op-1", ssid: "Home", five_ghz_ssid: "Home",
      });

      const result = await setApWifi(prisma as any, { ssid: "Home" });
      expect(setApWireless).toHaveBeenCalledTimes(2);
      expect(setApWireless).toHaveBeenCalledWith({ mac: MAC_A, ssid: "Home" });
      expect(setApWireless).toHaveBeenCalledWith({ mac: MAC_B, ssid: "Home" });
      expect(result.ssid).toBe("Home");
    });

    it("surfaces the derived 5 GHz name from the write response", async () => {
      const prisma = prismaWithAps([
        { mac: MAC_A, status: "ONLINE", backend: "DROPLET_IMAGE" },
      ]);
      getApWireless.mockResolvedValue(state({ band_steering: false }));
      setApWireless.mockResolvedValue({
        operationId: "op-1", ssid: "Split", five_ghz_ssid: "Split-5g",
      });
      await expect(setApWifi(prisma as any, { ssid: "Split" })).resolves.toMatchObject({
        ssid: "Split", fiveGhzSsid: "Split-5g", operationId: "op-1",
      });
    });

    it("422s with no ONLINE Droplet AP and writes nothing", async () => {
      const prisma = prismaWithAps([]);
      await expect(setApWifi(prisma as any, { ssid: "Home" })).rejects.toMatchObject({
        status: 422, code: "AP_WIRELESS_UNAVAILABLE",
      });
      expect(setApWireless).not.toHaveBeenCalled();
    });

    it("422s — without writing — when the AP cannot report wireless", async () => {
      const prisma = prismaWithAps([
        { mac: MAC_A, status: "ONLINE", backend: "DROPLET_IMAGE" },
      ]);
      getApWireless.mockResolvedValue({ supported: false, radios: [] });
      await expect(setApWifi(prisma as any, { ssid: "Home" })).rejects.toMatchObject({
        status: 422, code: "AP_WIRELESS_UNAVAILABLE",
      });
      expect(setApWireless).not.toHaveBeenCalled();
    });

    it("400s on an empty change with no reads or writes at all", async () => {
      const prisma = prismaWithAps([
        { mac: MAC_A, status: "ONLINE", backend: "DROPLET_IMAGE" },
      ]);
      await expect(setApWifi(prisma as any, {})).rejects.toMatchObject({ status: 400 });
      expect(getApWireless).not.toHaveBeenCalled();
      expect(setApWireless).not.toHaveBeenCalled();
    });

    it("never writes to a UniFi row", async () => {
      const prisma = prismaWithAps([
        { mac: MAC_A, status: "ONLINE", backend: "UNIFI" },
      ]);
      await expect(setApWifi(prisma as any, { ssid: "Home" })).rejects.toMatchObject({
        status: 422,
      });
      expect(setApWireless).not.toHaveBeenCalled();
    });
  });

  describe("getApWirelessForMac", () => {
    it("returns the per-AP detail for a Droplet row", async () => {
      const prisma = prismaWithAps([
        { mac: MAC_A, status: "ONLINE", backend: "DROPLET_IMAGE" },
      ]);
      getApWireless.mockResolvedValue(state());
      await expect(getApWirelessForMac(prisma as any, MAC_A)).resolves.toMatchObject({
        mac: MAC_A, supported: true, ssid: "Droplet",
      });
    });

    it("normalises the MAC before the lookup", async () => {
      const prisma = prismaWithAps([
        { mac: MAC_A, status: "ONLINE", backend: "DROPLET_IMAGE" },
      ]);
      getApWireless.mockResolvedValue(state());
      await getApWirelessForMac(prisma as any, "aa-bb-cc-dd-ee-01");
      expect(getApWireless).toHaveBeenCalledWith({ mac: MAC_A });
    });

    it("404s an unknown MAC", async () => {
      const prisma = prismaWithAps([]);
      await expect(getApWirelessForMac(prisma as any, MAC_A)).rejects.toMatchObject({
        status: 404,
      });
    });

    it("422s a vendor-managed AP rather than pretending to read its radios", async () => {
      const prisma = prismaWithAps([
        { mac: MAC_A, status: "ONLINE", backend: "UNIFI" },
      ]);
      await expect(getApWirelessForMac(prisma as any, MAC_A)).rejects.toMatchObject({
        status: 422, code: "AP_WIRELESS_UNAVAILABLE",
      });
      expect(getApWireless).not.toHaveBeenCalled();
    });
  });
});
