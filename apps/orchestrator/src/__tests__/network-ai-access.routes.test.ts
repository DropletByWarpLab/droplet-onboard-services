/**
 * droplet-ai RPC access read route + Tier-3 reservation (anti-drift).
 *
 * GET /network/ai-access is read-only (scope chips + session). The future
 * rotate/revoke writes are reserved Tier-3 (web-UI-only, AI-blocked) so the AI
 * can never trigger a self-lockout — there is NO dispatcher case yet. Pins:
 *   - the read route returns the service's scope/session shape;
 *   - rotate_ai_token + revoke_ai_access classify Tier 3.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: true, JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa", DROPLET_AP_MODE: "uci", agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

vi.mock("../services/network.service.js", () => ({
  getNetworkOverview: vi.fn(),
  getConnectedDevices: vi.fn().mockResolvedValue([]),
  getDhcpLeases: vi.fn().mockResolvedValue([]),
  getSystemInfo: vi.fn().mockResolvedValue({}),
  getAllInterfaces: vi.fn().mockResolvedValue([]),
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
  getAiNetworkAccess: vi.fn().mockResolvedValue({
    user: "droplet-ai",
    endpoint: "http://192.168.20.1:80/ubus",
    readScopes: ["system.board", "network.interface.*.status"],
    writeScopes: ["network.restart", "system.reboot"],
    session: { active: true, expiresAt: 1781890000, rotates: "hourly" },
  }),
}));

import { registerStatusRoutes } from "../routes/network-status.routes.js";
import { classifyNetworkCommand } from "../config/network-safety-rules.js";
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

describe("rotate/revoke AI access ops are reserved Tier 3 (AI-blocked)", () => {
  it('"rotate_ai_token" is Tier 3', () => {
    const c = classifyNetworkCommand("rotate_ai_token");
    expect(c.tier).toBe(3);
    expect(c.requiresConfirmation).toBe(true);
  });

  it('"revoke_ai_access" is Tier 3', () => {
    const c = classifyNetworkCommand("revoke_ai_access");
    expect(c.tier).toBe(3);
  });
});

describe("GET /api/network/ai-access", () => {
  it("returns the read-only scopes + session from the service", async () => {
    const res = await request(buildApp()).get("/api/network/ai-access");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      user: "droplet-ai",
      readScopes: ["system.board", "network.interface.*.status"],
      writeScopes: ["network.restart", "system.reboot"],
      session: { active: true, rotates: "hourly" },
    });
    // endpoint reflects the live single-box target, not legacy 192.168.50.1.
    expect(res.body.endpoint).not.toContain("192.168.50.1");
    expect(networkService.getAiNetworkAccess).toHaveBeenCalledOnce();
  });
});
