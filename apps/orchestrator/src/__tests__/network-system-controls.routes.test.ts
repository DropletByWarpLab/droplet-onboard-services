/**
 * System-controls route ↔ safety-tier contract (anti-drift).
 *
 * hostname is Tier 2 (re-keys mDNS/.local — confirm), NTP is Tier 1 (applies
 * immediately). Pins:
 *   - set_hostname classifies Tier 2; set_ntp stays Tier 1;
 *   - GET /network/system/controls reflects the gated controls;
 *   - POST /network/system/hostname mints a 202 + token (no write);
 *   - POST /network/system/ntp applies immediately (no confirm arm);
 *   - the full hostname 202 -> confirm -> dispatch path calls setHostname;
 *   - owner/admin only.
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
  getNetworkOverview: vi.fn(),
  getConnectedDevices: vi.fn().mockResolvedValue([]),
  getDhcpLeases: vi.fn().mockResolvedValue([]),
  getSystemInfo: vi.fn().mockResolvedValue({}),
  addStaticDhcpLease: vi.fn().mockResolvedValue({ operationId: "op-sl" }),
  getDhcpPool: vi.fn().mockResolvedValue({}),
  setDhcpPool: vi.fn().mockResolvedValue({ operationId: "op-pool" }),
  blockDevice: vi.fn().mockResolvedValue({ operationId: "op-b" }),
  unblockDevice: vi.fn().mockResolvedValue({ operationId: "op-u" }),
  addPortForward: vi.fn().mockResolvedValue({ operationId: "op-pf" }),
  setWifiPassword: vi.fn().mockResolvedValue({ operationId: "op-pw" }),
  setGuestWifi: vi.fn().mockResolvedValue({ operationId: "op-g" }),
  setUpnp: vi.fn().mockResolvedValue({ operationId: "op-upnp" }),
  rebootRouter: vi.fn().mockResolvedValue({ operationId: "op-rb" }),
  getRouterOperation: vi.fn(),
  // under test
  getSystemControls: vi.fn().mockResolvedValue({
    hostname: "droplet-rack-01",
    ntpEnabled: true,
    statusLed: { supported: false, enabled: false },
    country: { value: "US", editable: false },
  }),
  setHostname: vi.fn().mockResolvedValue({ operationId: "op-host" }),
  setNtpEnabled: vi.fn().mockResolvedValue({ operationId: "op-ntp" }),
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

const buildApp = () => buildAppAsRole("owner");

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

describe("system-control op classification", () => {
  it('"set_hostname" is Tier 2', () => {
    const c = classifyNetworkCommand("set_hostname");
    expect(c.tier).toBe(2);
    expect(c.requiresConfirmation).toBe(true);
  });

  it('"set_ntp" is Tier 1 — applies immediately', () => {
    const c = classifyNetworkCommand("set_ntp");
    expect(c.tier).toBe(1);
    expect(c.requiresConfirmation).toBe(false);
  });
});

describe("GET /api/network/system/controls", () => {
  it("reflects the gated controls from the service", async () => {
    const res = await request(buildApp()).get("/api/network/system/controls");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      hostname: "droplet-rack-01",
      ntpEnabled: true,
      statusLed: { supported: false },
      country: { value: "US", editable: false },
    });
    expect(networkService.getSystemControls).toHaveBeenCalledOnce();
  });
});

describe("POST /api/network/system/hostname", () => {
  it("requires confirmation: 202 + token, no write dispatched", async () => {
    const res = await request(buildApp())
      .post("/api/network/system/hostname")
      .send({ hostname: "studio-droplet" });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "confirmation_required",
      operation: "set_hostname",
      tier: 2,
    });
    expect(res.body.confirmationToken).toBeTruthy();
    expect(networkService.setHostname).not.toHaveBeenCalled();
  });

  it("rejects a malformed hostname with 400 before minting", async () => {
    const res = await request(buildApp())
      .post("/api/network/system/hostname")
      .send({ hostname: "Bad Name" });
    expect(res.status).toBe(400);
    expect(networkService.setHostname).not.toHaveBeenCalled();
  });

  it("rejects a family member with 403", async () => {
    const res = await request(buildAppAsRole("family"))
      .post("/api/network/system/hostname")
      .send({ hostname: "studio-droplet" });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/network/system/ntp", () => {
  it("applies immediately (Tier 1, no confirm arm)", async () => {
    const res = await request(buildApp())
      .post("/api/network/system/ntp")
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok" });
    expect(networkService.setNtpEnabled).toHaveBeenCalledWith(false);
  });

  it("rejects a non-boolean with 400", async () => {
    const res = await request(buildApp())
      .post("/api/network/system/ntp")
      .send({ enabled: "yes" });
    expect(res.status).toBe(400);
    expect(networkService.setNtpEnabled).not.toHaveBeenCalled();
  });

  it("rejects a family member with 403", async () => {
    const res = await request(buildAppAsRole("family"))
      .post("/api/network/system/ntp")
      .send({ enabled: true });
    expect(res.status).toBe(403);
  });
});

describe("Tier-2 confirm dispatch reaches setHostname", () => {
  it("202 token confirms and runs setHostname with the staged hostname", async () => {
    const app = buildFullApp();
    const minted = await request(app)
      .post("/api/network/system/hostname")
      .send({ hostname: "studio-droplet" });
    expect(minted.status).toBe(202);
    const token = minted.body.confirmationToken;

    const confirmed = await request(app)
      .post("/api/network/command/confirm")
      .send({ confirmationToken: token, operation: "set_hostname" });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({
      status: "ok",
      operation: "set_hostname",
      confirmed: true,
    });
    expect(networkService.setHostname).toHaveBeenCalledWith("studio-droplet");
  });
});
