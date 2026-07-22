/**
 * WARP-446 — orchestrator `/api/aps/*` routes + `ApOnboardService`.
 *
 * Covers the orchestrator-side of the extender onboarding flow per
 * ADR-005:
 *   - Discovery poller upserts mDNS-observed MACs into ApDevice.
 *   - GET /api/aps + GET /api/aps/discovered return the rows.
 *   - POST /api/aps/:mac/approve drives the state transition
 *     AWAITING_APPROVAL → PROVISIONING → ONLINE (or FAILED).
 *   - POST /api/aps/:mac/decommission drives ONLINE → DECOMMISSIONED.
 *   - All write routes require owner + admin (mirrored in rbac matrix).
 *
 * Same vitest pattern as vpn.test.ts: mock the openwrt.client at the
 * function level, build an in-memory Prisma stand-in for the ApDevice
 * table, hand the result to `createApsRouter`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

// ── Mocks (must be hoisted above any route imports) ──

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
  const actual = await vi.importActual<typeof import("../services/openwrt.client.js")>(
    "../services/openwrt.client.js",
  );
  return {
    ...actual,
    listDiscoveredAps: vi.fn(),
    getApStatus: vi.fn(),
    approveAp: vi.fn(),
    decommissionAp: vi.fn(),
    seedDiscoveredAp: vi.fn(),
  };
});

import { createApsRouter } from "../routes/aps.js";
import * as openwrt from "../services/openwrt.client.js";

// In-memory ApDevice stand-in.
function createPrismaMock() {
  const rows = new Map<string, any>();
  return {
    rows,
    apDevice: {
      findMany: vi.fn(async ({ where, orderBy }: any = {}) => {
        let result = [...rows.values()];
        if (where?.status) {
          if (where.status.in) {
            result = result.filter((r) => where.status.in.includes(r.status));
          } else {
            result = result.filter((r) => r.status === where.status);
          }
        }
        if (orderBy?.lastSeen === "desc") {
          result.sort((a, b) => +b.lastSeen - +a.lastSeen);
        }
        return result;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        return rows.get(where.mac) ?? null;
      }),
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

function buildApp(
  prismaMock: any,
  user: { username: string; role: string } = { username: "stefan", role: "owner" },
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { id: user.username, ...user, displayName: user.username };
    next();
  });
  app.use("/api", createApsRouter(prismaMock));
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "internal" });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────
// GET /api/aps
// ─────────────────────────────────────────────────────────────────

describe("GET /api/aps", () => {
  it("returns the full ApDevice list ordered by most-recently-seen", async () => {
    const prisma = createPrismaMock();
    prisma.rows.set("B8:27:EB:11:11:11", {
      mac: "B8:27:EB:11:11:11",
      status: "ONLINE",
      displayName: "Upstairs",
      lastSeen: new Date(2),
    });
    prisma.rows.set("B8:27:EB:22:22:22", {
      mac: "B8:27:EB:22:22:22",
      status: "AWAITING_APPROVAL",
      lastSeen: new Date(1),
    });
    const app = buildApp(prisma);
    const res = await request(app).get("/api/aps");
    expect(res.status).toBe(200);
    expect(res.body.aps.map((a: any) => a.mac)).toEqual([
      "B8:27:EB:11:11:11",
      "B8:27:EB:22:22:22",
    ]);
  });

  it("is readable by family-tier roles (AC #7 — GETs accept all auth roles)", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, { username: "alice", role: "family" });
    const res = await request(app).get("/api/aps");
    expect(res.status).toBe(200);
  });

  it("serializes the ADR-024 backend + vendor columns (so the dashboard can label the vendor)", async () => {
    // ADR-024 Phase 5 contract: the multi-backend dashboard surface reads
    // `backend` + `vendor` off each row to render the vendor badge. The
    // route returns the full ApDevice row (no `select`), so these columns
    // must pass through verbatim — this pins that they don't get dropped
    // by a future projection.
    const prisma = createPrismaMock();
    prisma.rows.set("AA:BB:CC:00:00:01", {
      mac: "AA:BB:CC:00:00:01",
      status: "ONLINE",
      backend: "EASYMESH",
      vendor: "TP-Link",
      lastSeen: new Date(2),
    });
    prisma.rows.set("AA:BB:CC:00:00:02", {
      mac: "AA:BB:CC:00:00:02",
      status: "AWAITING_APPROVAL",
      backend: "DROPLET_IMAGE",
      vendor: null,
      lastSeen: new Date(1),
    });
    const app = buildApp(prisma);
    const res = await request(app).get("/api/aps");
    expect(res.status).toBe(200);
    const byMac = Object.fromEntries(
      res.body.aps.map((a: any) => [a.mac, a]),
    );
    expect(byMac["AA:BB:CC:00:00:01"]).toMatchObject({
      backend: "EASYMESH",
      vendor: "TP-Link",
    });
    expect(byMac["AA:BB:CC:00:00:02"]).toMatchObject({
      backend: "DROPLET_IMAGE",
      vendor: null,
    });
  });

  it("surfaces the ADR-005 LRU cap as discoveredCap + discoveredCapReached", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    // Empty list — cap not reached.
    const res1 = await request(app).get("/api/aps");
    expect(res1.body.discoveredCap).toBe(25);
    expect(res1.body.discoveredCapReached).toBe(false);

    // Seed 25 AWAITING_APPROVAL rows so the cap reads as reached.
    for (let i = 0; i < 25; i += 1) {
      prisma.rows.set(`AA:BB:CC:00:00:${i.toString(16).padStart(2, "0").toUpperCase()}`, {
        mac: `AA:BB:CC:00:00:${i.toString(16).padStart(2, "0").toUpperCase()}`,
        status: "AWAITING_APPROVAL",
        lastSeen: new Date(i),
      });
    }
    const res2 = await request(app).get("/api/aps");
    expect(res2.body.discoveredCapReached).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// GET /api/aps/discovered
// ─────────────────────────────────────────────────────────────────

describe("GET /api/aps/discovered", () => {
  it("filters to AWAITING_APPROVAL + DISCOVERED so the dashboard's Add Extender wizard sees only actionable rows", async () => {
    const prisma = createPrismaMock();
    prisma.rows.set("B8:27:EB:00:00:01", {
      mac: "B8:27:EB:00:00:01",
      status: "AWAITING_APPROVAL",
      lastSeen: new Date(3),
    });
    prisma.rows.set("B8:27:EB:00:00:02", {
      mac: "B8:27:EB:00:00:02",
      status: "ONLINE",
      lastSeen: new Date(2),
    });
    prisma.rows.set("B8:27:EB:00:00:03", {
      mac: "B8:27:EB:00:00:03",
      status: "DECOMMISSIONED",
      lastSeen: new Date(1),
    });
    const app = buildApp(prisma);
    const res = await request(app).get("/api/aps/discovered");
    expect(res.status).toBe(200);
    expect(res.body.discovered.map((a: any) => a.mac)).toEqual([
      "B8:27:EB:00:00:01",
    ]);
  });

  it("serializes backend + vendor on discovered rows (ADR-024 Phase 5 dashboard contract)", async () => {
    const prisma = createPrismaMock();
    prisma.rows.set("AA:BB:CC:00:00:09", {
      mac: "AA:BB:CC:00:00:09",
      status: "AWAITING_APPROVAL",
      backend: "UNIFI",
      vendor: "Ubiquiti",
      lastSeen: new Date(5),
    });
    const app = buildApp(prisma);
    const res = await request(app).get("/api/aps/discovered");
    expect(res.status).toBe(200);
    expect(res.body.discovered[0]).toMatchObject({
      mac: "AA:BB:CC:00:00:09",
      backend: "UNIFI",
      vendor: "Ubiquiti",
    });
  });
});

// ─────────────────────────────────────────────────────────────────
// POST /api/aps/:mac/approve  (state transition + safe_apply push)
// ─────────────────────────────────────────────────────────────────

describe("POST /api/aps/:mac/approve", () => {
  function setupHappyPath() {
    (openwrt.approveAp as any).mockResolvedValue({
      status: "ok",
      mac: "B8:27:EB:00:00:01",
      iface_section: "ap_extender_b827eb000001",
      ssid: "Droplet",
      operation_id: "op-abc-123",
    });
  }

  it("404s when the MAC was never discovered", async () => {
    setupHappyPath();
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/aps/B8:27:EB:00:00:01/approve")
      .send({ ssid: "Droplet", encryptionKey: "longenoughpw" });
    expect(res.status).toBe(404);
    expect(openwrt.approveAp).not.toHaveBeenCalled();
  });

  it("normalizes the MAC at the boundary (CLAUDE.md rule)", async () => {
    setupHappyPath();
    const prisma = createPrismaMock();
    // Lower-case dash-separated input — normalizeMac must canonicalise.
    prisma.rows.set("B8:27:EB:00:00:01", {
      mac: "B8:27:EB:00:00:01",
      status: "AWAITING_APPROVAL",
      lastSeen: new Date(),
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/aps/b8-27-eb-00-00-01/approve")
      .send({ ssid: "Droplet", encryptionKey: "longenoughpw" });
    expect(res.status).toBe(200);
    expect(openwrt.approveAp).toHaveBeenCalledWith(
      expect.objectContaining({ mac: "B8:27:EB:00:00:01" }),
    );
  });

  it("transitions AWAITING_APPROVAL → ONLINE on success and captures operation_id + approvedBy", async () => {
    setupHappyPath();
    const prisma = createPrismaMock();
    prisma.rows.set("B8:27:EB:00:00:01", {
      mac: "B8:27:EB:00:00:01",
      status: "AWAITING_APPROVAL",
      lastSeen: new Date(),
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/aps/B8:27:EB:00:00:01/approve")
      .send({ ssid: "Droplet", encryptionKey: "longenoughpw" });
    expect(res.status).toBe(200);
    const row = prisma.rows.get("B8:27:EB:00:00:01");
    expect(row.status).toBe("ONLINE");
    expect(row.approvedBy).toBe("stefan");
    expect(row.approvedAt).toBeInstanceOf(Date);
    expect(row.approvedSsid).toBe("Droplet");
    expect(row.lastOperationId).toBe("op-abc-123");
    expect(row.failureReason).toBeNull();
  });

  it("returns { ap, operationId } so the dashboard can poll /api/network/operations/:id (AC #6 — blocker #2)", async () => {
    // setupHappyPath sets operation_id = "op-abc-123" on the
    // routing-service response. The orchestrator MUST pass it through
    // in the response body so the dashboard's optimistic-update flow
    // can poll the operation tracker until applied/rolled_back without
    // waiting for the 10s SWR refresh window.
    setupHappyPath();
    const prisma = createPrismaMock();
    prisma.rows.set("B8:27:EB:00:00:01", {
      mac: "B8:27:EB:00:00:01",
      status: "AWAITING_APPROVAL",
      lastSeen: new Date(),
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/aps/B8:27:EB:00:00:01/approve")
      .send({ ssid: "Droplet", encryptionKey: "longenoughpw" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ap: expect.objectContaining({
        mac: "B8:27:EB:00:00:01",
        status: "ONLINE",
      }),
      operationId: "op-abc-123",
    });
  });

  it("operationId is null when the routing layer didn't surface one (no header, old build)", async () => {
    // Real-mode routing service should always emit operation_id, but
    // the orchestrator must NOT crash when it doesn't (mock providers,
    // older routing builds, GET fallbacks). Dashboard treats null as
    // "no op tracking; just refresh /api/aps".
    (openwrt.approveAp as any).mockResolvedValue({
      status: "ok",
      mac: "B8:27:EB:00:00:01",
      iface_section: "ap_extender_b827eb000001",
      ssid: "Droplet",
      // operation_id intentionally omitted
    });
    const prisma = createPrismaMock();
    prisma.rows.set("B8:27:EB:00:00:01", {
      mac: "B8:27:EB:00:00:01",
      status: "AWAITING_APPROVAL",
      lastSeen: new Date(),
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/aps/B8:27:EB:00:00:01/approve")
      .send({ ssid: "Droplet", encryptionKey: "longenoughpw" });
    expect(res.status).toBe(200);
    expect(res.body.operationId).toBeNull();
  });

  it("transitions to FAILED with failureReason when the router push errors out (AC #5 — explicit state, no IS NULL derivation)", async () => {
    (openwrt.approveAp as any).mockRejectedValue(
      Object.assign(new Error("Router unreachable"), { code: "UNREACHABLE" }),
    );
    const prisma = createPrismaMock();
    prisma.rows.set("B8:27:EB:00:00:01", {
      mac: "B8:27:EB:00:00:01",
      status: "AWAITING_APPROVAL",
      lastSeen: new Date(),
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/aps/B8:27:EB:00:00:01/approve")
      .send({ ssid: "Droplet", encryptionKey: "longenoughpw" });
    expect(res.status).toBe(502);
    const row = prisma.rows.get("B8:27:EB:00:00:01");
    expect(row.status).toBe("FAILED");
    expect(row.failureReason).toMatch(/Router unreachable/);
  });

  it("rejects an SSID that's empty (boundary)", async () => {
    setupHappyPath();
    const prisma = createPrismaMock();
    prisma.rows.set("B8:27:EB:00:00:01", {
      mac: "B8:27:EB:00:00:01",
      status: "AWAITING_APPROVAL",
      lastSeen: new Date(),
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/aps/B8:27:EB:00:00:01/approve")
      .send({ ssid: "", encryptionKey: "longenoughpw" });
    expect(res.status).toBe(400);
  });

  it("rejects a PSK shorter than WPA2 minimum (8 chars)", async () => {
    setupHappyPath();
    const prisma = createPrismaMock();
    prisma.rows.set("B8:27:EB:00:00:01", {
      mac: "B8:27:EB:00:00:01",
      status: "AWAITING_APPROVAL",
      lastSeen: new Date(),
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/aps/B8:27:EB:00:00:01/approve")
      .send({ ssid: "Droplet", encryptionKey: "short" });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────
// POST /api/aps/:mac/decommission
// ─────────────────────────────────────────────────────────────────

describe("POST /api/aps/:mac/decommission", () => {
  it("transitions ONLINE → DECOMMISSIONED with timestamp", async () => {
    (openwrt.decommissionAp as any).mockResolvedValue({
      status: "ok",
      mac: "B8:27:EB:00:00:01",
      operation_id: "op-decom-1",
    });
    const prisma = createPrismaMock();
    prisma.rows.set("B8:27:EB:00:00:01", {
      mac: "B8:27:EB:00:00:01",
      status: "ONLINE",
      approvedAt: new Date(),
      lastSeen: new Date(),
    });
    const app = buildApp(prisma);
    const res = await request(app).post("/api/aps/B8:27:EB:00:00:01/decommission");
    expect(res.status).toBe(200);
    const row = prisma.rows.get("B8:27:EB:00:00:01");
    expect(row.status).toBe("DECOMMISSIONED");
    expect(row.decommissionedAt).toBeInstanceOf(Date);
    expect(row.lastOperationId).toBe("op-decom-1");
  });

  it("returns { ap, operationId } so the dashboard can poll on remove (AC #6 — blocker #2)", async () => {
    (openwrt.decommissionAp as any).mockResolvedValue({
      status: "ok",
      mac: "B8:27:EB:00:00:01",
      operation_id: "op-decom-2",
    });
    const prisma = createPrismaMock();
    prisma.rows.set("B8:27:EB:00:00:01", {
      mac: "B8:27:EB:00:00:01",
      status: "ONLINE",
      lastSeen: new Date(),
    });
    const app = buildApp(prisma);
    const res = await request(app).post("/api/aps/B8:27:EB:00:00:01/decommission");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ap: expect.objectContaining({
        mac: "B8:27:EB:00:00:01",
        status: "DECOMMISSIONED",
      }),
      operationId: "op-decom-2",
    });
  });

  it("returns operationId: null for the idempotent already-decommissioned short-circuit", async () => {
    // No routing call fires — the orchestrator short-circuits — so the
    // operation tracker has nothing to poll. Dashboard treats null as
    // "no in-flight write; just refresh".
    const prisma = createPrismaMock();
    prisma.rows.set("B8:27:EB:00:00:01", {
      mac: "B8:27:EB:00:00:01",
      status: "DECOMMISSIONED",
      decommissionedAt: new Date(100),
      lastSeen: new Date(),
    });
    const app = buildApp(prisma);
    const res = await request(app).post("/api/aps/B8:27:EB:00:00:01/decommission");
    expect(res.status).toBe(200);
    expect(res.body.operationId).toBeNull();
    expect(openwrt.decommissionAp).not.toHaveBeenCalled();
  });

  it("is idempotent on already-decommissioned APs (operator double-click safe)", async () => {
    (openwrt.decommissionAp as any).mockResolvedValue({
      status: "ok",
      mac: "B8:27:EB:00:00:01",
      operation_id: "op-decom-2",
    });
    const prisma = createPrismaMock();
    prisma.rows.set("B8:27:EB:00:00:01", {
      mac: "B8:27:EB:00:00:01",
      status: "DECOMMISSIONED",
      decommissionedAt: new Date(100),
      lastSeen: new Date(),
    });
    const app = buildApp(prisma);
    const res = await request(app).post("/api/aps/B8:27:EB:00:00:01/decommission");
    // Already-terminal → success-equivalent.
    expect(res.status).toBe(200);
    // Routing service is NOT called twice — the orchestrator short-circuits.
    expect(openwrt.decommissionAp).not.toHaveBeenCalled();
  });

  it("404s when the MAC is unknown", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app).post("/api/aps/B8:27:EB:00:00:99/decommission");
    expect(res.status).toBe(404);
  });
});
