/**
 * DHCP pool route ↔ safety-tier contract (anti-drift).
 *
 * Reshaping the LAN DHCP pool (start/limit/leasetime) is Tier 2 — shrinking it
 * can strand connected clients — so the write must round-trip through the
 * /network/command/confirm dispatcher, not apply on the first POST. These pin:
 *   - the operation string classifies to Tier 2;
 *   - GET reflects the pool from the service;
 *   - POST mints a 202 + token and dispatches NO write;
 *   - the full 202 -> confirm -> dispatch path actually calls setDhcpPool
 *     (the dispatcher case the per-route 202 arm can't see);
 *   - owner/admin only; validation rejects junk before any router change.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    DROPLET_AP_MODE: "uci",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/network.service.js", () => ({
  // status-route deps that aren't under test, stubbed so the router builds.
  getNetworkOverview: vi.fn(),
  getConnectedDevices: vi.fn().mockResolvedValue([]),
  getDhcpLeases: vi.fn().mockResolvedValue([]),
  getSystemInfo: vi.fn().mockResolvedValue({}),
  addStaticDhcpLease: vi.fn().mockResolvedValue({ operationId: "op-sl" }),
  blockDevice: vi.fn().mockResolvedValue({ operationId: "op-b" }),
  unblockDevice: vi.fn().mockResolvedValue({ operationId: "op-u" }),
  addPortForward: vi.fn().mockResolvedValue({ operationId: "op-pf" }),
  setWifiPassword: vi.fn().mockResolvedValue({ operationId: "op-pw" }),
  setGuestWifi: vi.fn().mockResolvedValue({ operationId: "op-g" }),
  setUpnp: vi.fn().mockResolvedValue({ operationId: "op-upnp" }),
  rebootRouter: vi.fn().mockResolvedValue({ operationId: "op-rb" }),
  getRouterOperation: vi.fn(),
  // under test
  getDhcpPool: vi.fn().mockResolvedValue({ start: "100", limit: "150", leasetime: "12h" }),
  setDhcpPool: vi.fn().mockResolvedValue({ operationId: "op-pool" }),
}));

import { registerStatusRoutes } from "../routes/network-status.routes.js";
import { classifyNetworkCommand } from "../config/network-safety-rules.js";
import * as networkService from "../services/network.service.js";
import type { AuthUser } from "../middleware/auth.js";

function createPrismaMock() {
  return {
    commandAuditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaClient;
}

const owner: AuthUser = {
  id: "u-owner",
  username: "stefan",
  displayName: "stefan",
  role: "owner",
};

function buildAppAsRole(role: AuthUser["role"]): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = { ...owner, role };
    next();
  });
  const router = express.Router();
  registerStatusRoutes(router, { prisma: createPrismaMock(), networkDeviceService: {} as never });
  app.use("/api", router);
  return app;
}

function buildApp(): express.Express {
  return buildAppAsRole("owner");
}

// Full pipeline: ONE prisma shared by the mint route + the confirm dispatcher,
// real network-safety service, so a minted token actually dispatches.
function buildFullApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = owner;
    next();
  });
  const prisma = createPrismaMock();
  const router = express.Router();
  registerStatusRoutes(router, { prisma, networkDeviceService: {} as never });
  app.use("/api", router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('"set_dhcp_pool" classifies to Tier 2', () => {
  it("requires confirmation", () => {
    const c = classifyNetworkCommand("set_dhcp_pool");
    expect(c.tier).toBe(2);
    expect(c.requiresConfirmation).toBe(true);
  });
});

describe("GET /api/network/dhcp/pool", () => {
  it("reflects the pool from the service", async () => {
    const res = await request(buildApp()).get("/api/network/dhcp/pool");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ start: "100", limit: "150", leasetime: "12h" });
    expect(networkService.getDhcpPool).toHaveBeenCalledOnce();
  });
});

describe("POST /api/network/dhcp/pool", () => {
  it("requires confirmation: 202 + token, no write dispatched", async () => {
    const res = await request(buildApp())
      .post("/api/network/dhcp/pool")
      .send({ start: 120, limit: 130, leasetime: "24h" });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "confirmation_required",
      operation: "set_dhcp_pool",
      tier: 2,
    });
    expect(res.body.confirmationToken).toBeTruthy();
    expect(networkService.setDhcpPool).not.toHaveBeenCalled();
  });

  it("rejects out-of-range start with 400 before any router change", async () => {
    const res = await request(buildApp())
      .post("/api/network/dhcp/pool")
      .send({ start: 1, limit: 130, leasetime: "24h" });
    expect(res.status).toBe(400);
    expect(networkService.setDhcpPool).not.toHaveBeenCalled();
  });

  it("rejects a bad lease-time format with 400", async () => {
    const res = await request(buildApp())
      .post("/api/network/dhcp/pool")
      .send({ start: 120, limit: 130, leasetime: "forever" });
    expect(res.status).toBe(400);
    expect(networkService.setDhcpPool).not.toHaveBeenCalled();
  });

  it("rejects a family member with 403", async () => {
    const res = await request(buildAppAsRole("family"))
      .post("/api/network/dhcp/pool")
      .send({ start: 120, limit: 130, leasetime: "24h" });
    expect(res.status).toBe(403);
    expect(networkService.setDhcpPool).not.toHaveBeenCalled();
  });
});

describe("Tier-2 confirm dispatch reaches setDhcpPool", () => {
  it("202 token confirms and runs setDhcpPool with the staged params", async () => {
    const app = buildFullApp();
    const minted = await request(app)
      .post("/api/network/dhcp/pool")
      .send({ start: 120, limit: 130, leasetime: "24h" });
    expect(minted.status).toBe(202);
    const token = minted.body.confirmationToken;

    const confirmed = await request(app)
      .post("/api/network/command/confirm")
      .send({ confirmationToken: token, operation: "set_dhcp_pool" });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({
      status: "ok",
      operation: "set_dhcp_pool",
      confirmed: true,
    });
    expect(networkService.setDhcpPool).toHaveBeenCalledOnce();
    expect(networkService.setDhcpPool).toHaveBeenCalledWith(120, 130, "24h");
  });
});
