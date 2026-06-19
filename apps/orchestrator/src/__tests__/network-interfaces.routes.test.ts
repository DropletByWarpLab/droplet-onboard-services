/**
 * Full interface enumeration read route.
 *
 * Orchestrator GET /network/interfaces returns every configured interface with
 * name/device/proto/address/zone/status (the `/all` suffix is the routing-service
 * path, one layer down). Read-only — no tier, no write. Pins that the route
 * returns the service's enumerated rows.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: true, JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa", DROPLET_AP_MODE: "uci" },
}));

vi.mock("../services/network.service.js", () => ({
  getNetworkOverview: vi.fn(),
  getConnectedDevices: vi.fn().mockResolvedValue([]),
  getDhcpLeases: vi.fn().mockResolvedValue([]),
  getSystemInfo: vi.fn().mockResolvedValue({}),
  addStaticDhcpLease: vi.fn(),
  getDhcpPool: vi.fn(),
  setDhcpPool: vi.fn(),
  getSystemControls: vi.fn(),
  setHostname: vi.fn(),
  setNtpEnabled: vi.fn(),
  blockDevice: vi.fn(),
  unblockDevice: vi.fn(),
  addPortForward: vi.fn(),
  setWifiPassword: vi.fn(),
  setGuestWifi: vi.fn(),
  setUpnp: vi.fn(),
  rebootRouter: vi.fn(),
  getRouterOperation: vi.fn(),
  // under test
  getAllInterfaces: vi.fn().mockResolvedValue([
    { name: "lan", device: "br-lan", proto: "static", address: "10.0.0.1/24", zone: "lan", up: true, present: true },
    { name: "cameras", device: "br-lan.100", proto: "static", address: null, zone: "cameras", up: false, present: false },
  ]),
}));

import { registerStatusRoutes } from "../routes/network-status.routes.js";
import * as networkService from "../services/network.service.js";
import type { AuthUser } from "../middleware/auth.js";

function createPrismaMock() {
  return {
    commandAuditLog: { create: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaClient;
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = {
      id: "u-owner", username: "stefan", displayName: "stefan", role: "owner",
    };
    next();
  });
  const router = express.Router();
  registerStatusRoutes(router, { prisma: createPrismaMock(), networkDeviceService: {} as never });
  app.use("/api", router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/network/interfaces", () => {
  it("returns the enumerated interface rows from the service", async () => {
    const res = await request(buildApp()).get("/api/network/interfaces");
    expect(res.status).toBe(200);
    expect(res.body.interfaces).toHaveLength(2);
    expect(res.body.interfaces[0]).toMatchObject({ name: "lan", zone: "lan", present: true });
    // present:false rows are surfaced honestly, not dropped.
    expect(res.body.interfaces[1]).toMatchObject({ name: "cameras", present: false });
    expect(networkService.getAllInterfaces).toHaveBeenCalledOnce();
  });
});
