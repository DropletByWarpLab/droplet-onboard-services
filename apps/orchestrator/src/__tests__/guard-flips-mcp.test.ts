/**
 * WARP-1461 — MCP-principal admission on the five shipped-tool routes the
 * WARP-1455 audit found still behind plain `requireRole`.
 *
 * Four LLM tools dispatch through orchestrator routes that 403'd the
 * `_service:mcp` principal (role "service") because the route used
 * `requireRole` instead of `requireRoleOrMcpService`:
 *
 *   - get_command_history      → GET   /api/matter/audit        (matter.ts)
 *   - approve_ap               → POST  /api/aps/:mac/approve     (aps.ts)
 *   - decommission_ap          → POST  /api/aps/:mac/decommission(aps.ts)
 *   - set_phone_home_blocking  → PATCH /api/network/groups/:id   (network-devices.routes.ts)
 *   - set_phone_home_blocking  → PATCH /api/network/phone-home   (network-phone-home.routes.ts)
 *
 * Each route now uses `requireRoleOrMcpService(...)` with the SAME human
 * role set — the flip only lets the `_service:mcp` principal REACH the
 * handler; it never bypasses the handler's own confirmation/safety logic.
 * These tests pin, per route, that the MCP principal is no longer
 * auth-rejected (reaches route logic; the underlying service/handler runs)
 * AND that human RBAC is byte-identical (owner passes; a role OUTSIDE the
 * route's set — family on these owner/admin routes — still 403s).
 *
 * Scaffolding per updates-mcp-guards.test.ts: real auth guards, a req.user
 * shim, and heavy services mocked so no sidecar, router, or Prisma is ever
 * touched.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Router, type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

// Keep the guard's fire-and-forget "Access denied" activity write inert.
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

// matter.ts imports the sidecar HTTP client at load; the audit route itself
// never calls it (it reads the command-audit log via the REAL safety-tier
// service against the prisma mock below), but createMatterRouter references
// these bindings when registering the other routes.
vi.mock("../services/matter.service.js", () => ({
  isMatterInitialized: vi.fn().mockReturnValue(true),
  getCommissionedDevices: vi.fn().mockResolvedValue({}),
  getDevice: vi.fn(),
  sendMatterCommand: vi.fn().mockResolvedValue({ status: "success" }),
  discoverDevices: vi.fn().mockResolvedValue([]),
  commissionDevice: vi.fn().mockResolvedValue({ nodeId: "42" }),
  decommissionDevice: vi.fn().mockResolvedValue(true),
  subscribeStateChanges: vi.fn().mockReturnValue(() => {}),
  subscribeConnectionChanges: vi.fn().mockReturnValue(() => {}),
  getMatterCapabilities: vi.fn().mockResolvedValue({}),
}));

// aps.ts state machine — mocked so the guard test never reaches the routing
// service / openwrt client. ApOnboardError must be a real class (the route
// does `err instanceof ApOnboardError`); DISCOVERED_AP_LRU_CAP is read by the
// GET routes at registration-adjacent handler time.
vi.mock("../services/ap-onboard.service.js", () => {
  class ApOnboardError extends Error {
    status: number;
    code: string;
    constructor(message: string, status = 500, code = "AP_ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApOnboardError,
    DISCOVERED_AP_LRU_CAP: 25,
    approveAp: vi
      .fn()
      .mockResolvedValue({ ap: { mac: "AA:BB:CC:DD:EE:FF", status: "ONLINE" }, operationId: "op-approve" }),
    decommissionAp: vi
      .fn()
      .mockResolvedValue({ ap: { mac: "AA:BB:CC:DD:EE:FF", status: "DECOMMISSIONED" }, operationId: "op-decom" }),
    // WARP-1703: imported by network-wifi.routes.ts.
    getBandSteering: vi.fn().mockResolvedValue({ supported: false, enabled: false }),
    setBandSteering: vi.fn().mockResolvedValue({ operationId: null }),
    // WARP-1712: imported by network-wifi.routes.ts (getApWifi/setApWifi),
    // network-status.routes.ts (setApWifi) and aps.ts (getApWirelessForMac).
    getApWifi: vi.fn().mockResolvedValue({
      supported: false, ssid: null, fiveGhzSsid: null, key: null,
      encryption: null, bandSteering: null, apCount: 0, inSync: true,
    }),
    setApWifi: vi
      .fn()
      .mockResolvedValue({ operationId: null, ssid: null, fiveGhzSsid: null }),
    getApWirelessForMac: vi.fn().mockResolvedValue({
      mac: "AA:BB:CC:DD:EE:FF", supported: false, radios: [],
    }),
  };
});

// network-phone-home.routes.ts egress writes — mocked so the PATCH handler
// never touches Prisma/reconciler; a resolved settings read proves it ran.
vi.mock("../services/egress.service.js", () => ({
  MASTER_SETTING_KEY: "network.block_phone_home_enabled",
  CAMERAS_SETTING_KEY: "network.cameras_block_phone_home",
  getPhoneHomeSettings: vi.fn().mockResolvedValue({ enabled: true, cameras: false }),
  getPhoneHomeView: vi.fn().mockResolvedValue({}),
  setPhoneHomeSetting: vi.fn().mockResolvedValue(undefined),
}));

import { createMatterRouter } from "../routes/matter.js";
import { createApsRouter } from "../routes/aps.js";
import { registerDeviceRoutes } from "../routes/network-devices.routes.js";
import { registerPhoneHomeRoutes } from "../routes/network-phone-home.routes.js";
import * as apOnboard from "../services/ap-onboard.service.js";
import * as egress from "../services/egress.service.js";
import type { AuthUser } from "../middleware/auth.js";

const mcpPrincipal: AuthUser = {
  id: "_service:mcp",
  username: "_service:mcp",
  displayName: "MCP Server",
  role: "service",
};
const owner: AuthUser = {
  id: "u-owner",
  username: "romain",
  displayName: "romain",
  role: "owner",
};
// A role OUTSIDE the owner/admin set every one of these five routes guards.
const family: AuthUser = {
  id: "u-fam",
  username: "fam",
  displayName: "fam",
  role: "family",
};

/** Command-audit-log prisma stand-in for the matter audit route. */
function createPrismaMock() {
  return {
    commandAuditLog: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaClient;
}

/** renameGroup is the only networkDeviceService method the PATCH /groups route hits. */
function createNetworkDeviceServiceMock() {
  return {
    renameGroup: vi
      .fn()
      .mockResolvedValue({ id: "g1", name: "Kids", blockPhoneHome: true }),
  };
}

function buildApp(
  user: AuthUser,
  opts: {
    prisma?: PrismaClient;
    networkDeviceService?: ReturnType<typeof createNetworkDeviceServiceMock>;
  } = {},
): express.Express {
  const prisma = opts.prisma ?? createPrismaMock();
  const networkDeviceService =
    opts.networkDeviceService ?? createNetworkDeviceServiceMock();

  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });

  app.use("/api", createMatterRouter(prisma));
  app.use("/api", createApsRouter(prisma));

  const netRouter = Router();
  registerDeviceRoutes(netRouter, {
    networkDeviceService:
      networkDeviceService as unknown as Parameters<
        typeof registerDeviceRoutes
      >[1]["networkDeviceService"],
  });
  registerPhoneHomeRoutes(netRouter, { prisma });
  app.use("/api", netRouter);

  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── get_command_history → GET /api/matter/audit ──────────────────────────

describe("GET /api/matter/audit (get_command_history) — matter.ts", () => {
  it("MCP principal reaches route logic (not 401/403); the audit read runs", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(mcpPrincipal, { prisma })).get("/api/matter/audit");

    expect([401, 403]).not.toContain(res.status);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ logs: [] });
    expect((prisma.commandAuditLog.findMany as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
  });

  it("human RBAC unchanged: owner passes, family (outside owner/admin) 403s", async () => {
    const ownerPrisma = createPrismaMock();
    const ownerRes = await request(buildApp(owner, { prisma: ownerPrisma })).get(
      "/api/matter/audit",
    );
    expect([401, 403]).not.toContain(ownerRes.status);

    const famPrisma = createPrismaMock();
    const famRes = await request(buildApp(family, { prisma: famPrisma })).get(
      "/api/matter/audit",
    );
    expect(famRes.status).toBe(403);
    expect((famPrisma.commandAuditLog.findMany as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

// ── approve_ap → POST /api/aps/:mac/approve ──────────────────────────────

describe("POST /api/aps/:mac/approve (approve_ap) — aps.ts", () => {
  it("MCP principal reaches route logic (not 401/403); approveAp runs", async () => {
    const res = await request(buildApp(mcpPrincipal))
      .post("/api/aps/AA:BB:CC:DD:EE:FF/approve")
      .send({ ssid: "Droplet", encryptionKey: "longenoughpw" });

    expect([401, 403]).not.toContain(res.status);
    expect(res.status).toBe(200);
    expect(apOnboard.approveAp).toHaveBeenCalledOnce();
  });

  it("human RBAC unchanged: owner passes, family 403s (approveAp never runs)", async () => {
    const ownerRes = await request(buildApp(owner))
      .post("/api/aps/AA:BB:CC:DD:EE:FF/approve")
      .send({ ssid: "Droplet", encryptionKey: "longenoughpw" });
    expect([401, 403]).not.toContain(ownerRes.status);
    expect(apOnboard.approveAp).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    const famRes = await request(buildApp(family))
      .post("/api/aps/AA:BB:CC:DD:EE:FF/approve")
      .send({ ssid: "Droplet", encryptionKey: "longenoughpw" });
    expect(famRes.status).toBe(403);
    expect(apOnboard.approveAp).not.toHaveBeenCalled();
  });
});

// ── decommission_ap → POST /api/aps/:mac/decommission ────────────────────

describe("POST /api/aps/:mac/decommission (decommission_ap) — aps.ts", () => {
  it("MCP principal reaches route logic (not 401/403); decommissionAp runs", async () => {
    const res = await request(buildApp(mcpPrincipal)).post(
      "/api/aps/AA:BB:CC:DD:EE:FF/decommission",
    );

    expect([401, 403]).not.toContain(res.status);
    expect(res.status).toBe(200);
    expect(apOnboard.decommissionAp).toHaveBeenCalledOnce();
  });

  it("human RBAC unchanged: family 403s (decommissionAp never runs)", async () => {
    const famRes = await request(buildApp(family)).post(
      "/api/aps/AA:BB:CC:DD:EE:FF/decommission",
    );
    expect(famRes.status).toBe(403);
    expect(apOnboard.decommissionAp).not.toHaveBeenCalled();
  });
});

// ── set_phone_home_blocking → PATCH /api/network/groups/:id ───────────────
// (per-group scope)

describe("PATCH /api/network/groups/:id (set_phone_home_blocking) — network-devices.routes.ts", () => {
  it("MCP principal reaches route logic (not 401/403); renameGroup runs", async () => {
    const networkDeviceService = createNetworkDeviceServiceMock();
    const res = await request(buildApp(mcpPrincipal, { networkDeviceService }))
      .patch("/api/network/groups/g1")
      .send({ blockPhoneHome: true });

    expect([401, 403]).not.toContain(res.status);
    expect(res.status).toBe(200);
    expect(networkDeviceService.renameGroup).toHaveBeenCalledOnce();
  });

  it("human RBAC unchanged: owner passes, family 403s (renameGroup never runs)", async () => {
    const ownerSvc = createNetworkDeviceServiceMock();
    const ownerRes = await request(buildApp(owner, { networkDeviceService: ownerSvc }))
      .patch("/api/network/groups/g1")
      .send({ blockPhoneHome: true });
    expect([401, 403]).not.toContain(ownerRes.status);
    expect(ownerSvc.renameGroup).toHaveBeenCalledOnce();

    const famSvc = createNetworkDeviceServiceMock();
    const famRes = await request(buildApp(family, { networkDeviceService: famSvc }))
      .patch("/api/network/groups/g1")
      .send({ blockPhoneHome: true });
    expect(famRes.status).toBe(403);
    expect(famSvc.renameGroup).not.toHaveBeenCalled();
  });
});

// ── set_phone_home_blocking → PATCH /api/network/phone-home ───────────────
// (global scope)

describe("PATCH /api/network/phone-home (set_phone_home_blocking) — network-phone-home.routes.ts", () => {
  it("MCP principal reaches route logic (not 401/403); the egress write runs", async () => {
    const res = await request(buildApp(mcpPrincipal))
      .patch("/api/network/phone-home")
      .send({ enabled: true });

    expect([401, 403]).not.toContain(res.status);
    expect(res.status).toBe(200);
    expect(egress.setPhoneHomeSetting).toHaveBeenCalledOnce();
  });

  it("human RBAC unchanged: owner passes, family 403s (no egress write)", async () => {
    const ownerRes = await request(buildApp(owner))
      .patch("/api/network/phone-home")
      .send({ enabled: true });
    expect([401, 403]).not.toContain(ownerRes.status);
    expect(egress.setPhoneHomeSetting).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    const famRes = await request(buildApp(family))
      .patch("/api/network/phone-home")
      .send({ enabled: true });
    expect(famRes.status).toBe(403);
    expect(egress.setPhoneHomeSetting).not.toHaveBeenCalled();
  });
});
