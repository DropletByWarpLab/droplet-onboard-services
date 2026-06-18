/**
 * Guest Wi-Fi + UPnP route ↔ safety-tier contract (anti-drift).
 *
 * Both new write surfaces are Tier 2 (a new broadcasting SSID + firewall zone;
 * automatic port opening). These pin that from both ends — the operation string
 * classifies to Tier 2, and the route surfaces the 202 confirmation arm without
 * dispatching the write — plus the read + validation behaviour.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
  },
}));

vi.mock("../services/network.service.js", () => ({
  // wifi route deps
  getWifiSettings: vi.fn().mockResolvedValue({}),
  scanWifiNetworks: vi.fn().mockResolvedValue([]),
  setWifiSsid: vi.fn().mockResolvedValue(undefined),
  setWifiPassword: vi.fn().mockResolvedValue({ operationId: "op-1" }),
  setWifiChannel: vi.fn().mockResolvedValue({ operationId: "op-2" }),
  setGuestWifi: vi.fn().mockResolvedValue({ operationId: "op-guest" }),
  getGuestWifi: vi.fn().mockResolvedValue({
    configured: false,
    enabled: false,
    ssid: null,
    password: null,
  }),
  removeGuestWifi: vi.fn().mockResolvedValue({ operationId: "op-rm" }),
  // firewall route deps
  getFirewallConfig: vi.fn().mockResolvedValue({ zones: {}, rules: {}, redirects: {} }),
  blockDevice: vi.fn().mockResolvedValue({ operationId: "op-b" }),
  unblockDevice: vi.fn().mockResolvedValue({ operationId: "op-u" }),
  addPortForward: vi.fn().mockResolvedValue({ operationId: "op-pf" }),
  getUpnp: vi.fn().mockResolvedValue({ available: false, enabled: false }),
  setUpnp: vi.fn().mockResolvedValue({ operationId: "op-upnp" }),
}));

import { registerWifiRoutes } from "../routes/network-wifi.routes.js";
import { registerFirewallRoutes } from "../routes/network-firewall.routes.js";
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

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = owner;
    next();
  });
  const router = express.Router();
  registerWifiRoutes(router, { prisma: createPrismaMock() });
  registerFirewallRoutes(router, { prisma: createPrismaMock() });
  app.use("/api", router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("guest + upnp operation strings classify to Tier 2", () => {
  it('"create_guest_network" is Tier 2 — confirmation required', () => {
    const c = classifyNetworkCommand("create_guest_network");
    expect(c.tier).toBe(2);
    expect(c.requiresConfirmation).toBe(true);
  });

  it('"set_upnp" is Tier 2 — confirmation required', () => {
    const c = classifyNetworkCommand("set_upnp");
    expect(c.tier).toBe(2);
    expect(c.requiresConfirmation).toBe(true);
  });
});

describe("POST /api/network/wifi/guest", () => {
  it("requires confirmation: 202 + token, no write dispatched", async () => {
    const res = await request(buildApp())
      .post("/api/network/wifi/guest")
      .send({ ssid: "Studio Guest", password: "longenoughpw" });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "confirmation_required",
      operation: "create_guest_network",
      tier: 2,
    });
    expect(res.body.confirmationToken).toBeTruthy();
    expect(networkService.setGuestWifi).not.toHaveBeenCalled();
  });

  it("rejects a missing SSID with 400", async () => {
    const res = await request(buildApp())
      .post("/api/network/wifi/guest")
      .send({ password: "longenoughpw" });
    expect(res.status).toBe(400);
  });

  it("rejects a too-short password with 400", async () => {
    const res = await request(buildApp())
      .post("/api/network/wifi/guest")
      .send({ ssid: "Studio Guest", password: "short" });
    expect(res.status).toBe(400);
  });
});

describe("guest wifi read + teardown", () => {
  it("GET /api/network/wifi/guest reflects status from the service", async () => {
    const res = await request(buildApp()).get("/api/network/wifi/guest");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ configured: false, enabled: false });
    expect(networkService.getGuestWifi).toHaveBeenCalledOnce();
  });

  it("DELETE /api/network/wifi/guest applies immediately (no confirm arm)", async () => {
    const res = await request(buildApp()).delete("/api/network/wifi/guest");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok" });
    expect(networkService.removeGuestWifi).toHaveBeenCalledOnce();
  });
});

describe("UPnP routes", () => {
  it("GET /api/network/upnp reflects state from the service", async () => {
    const res = await request(buildApp()).get("/api/network/upnp");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, enabled: false });
    expect(networkService.getUpnp).toHaveBeenCalledOnce();
  });

  it("POST /api/network/upnp requires confirmation: 202 + token, no write", async () => {
    const res = await request(buildApp())
      .post("/api/network/upnp")
      .send({ enabled: true });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "confirmation_required",
      operation: "set_upnp",
      tier: 2,
    });
    expect(res.body.confirmationToken).toBeTruthy();
    expect(networkService.setUpnp).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean enabled with 400", async () => {
    const res = await request(buildApp())
      .post("/api/network/upnp")
      .send({ enabled: "yes" });
    expect(res.status).toBe(400);
  });
});
