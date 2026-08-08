/**
 * MCP service principal ↔ network write routes (requireRoleOrMcpService).
 *
 * LLM network tools dispatch through the mcp-server, which calls back into
 * the orchestrator presenting the `_service:mcp` bearer (role "service").
 * `requireRoleOrMcpService` admits exactly that principal — not the coarse
 * "service" role — so tool calls reach the network-safety evaluator instead
 * of 403ing in front of it (the WARP-339 gap, network edition).
 *
 * Uses the REAL network-safety service so the assertions pin end-to-end
 * behavior: Tier-1 ops execute (200, tier echo), Tier-2 ops mint a 202 and
 * never execute. WARP-1443: the password route now admits the MCP principal
 * too (set_wifi_password tool — Tier-2, so the AI path only ever mints a
 * 202 here). Other service principals (voice) stay excluded everywhere.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/network.service.js", () => ({
  getWifiSettings: vi.fn().mockResolvedValue({}),
  scanWifiNetworks: vi.fn().mockResolvedValue([]),
  setWifiSsid: vi.fn().mockResolvedValue(undefined),
  setWifiPassword: vi.fn().mockResolvedValue({ operationId: "op-1" }),
  setWifiChannel: vi.fn().mockResolvedValue({ operationId: "op-2" }),
  getFirewallConfig: vi.fn().mockResolvedValue({ zones: [], rules: [], redirects: [] }),
  blockDevice: vi.fn().mockResolvedValue({ operationId: "op-3" }),
  unblockDevice: vi.fn().mockResolvedValue({ operationId: "op-4" }),
  addPortForward: vi.fn().mockResolvedValue({ operationId: "op-5" }),
  // network-status.routes.ts imports (confirm-endpoint guard tests below)
  getNetworkOverview: vi.fn().mockResolvedValue({ ok: true, value: {} }),
  getConnectedDevices: vi.fn().mockResolvedValue([]),
  getDhcpLeases: vi.fn().mockResolvedValue([]),
  getSystemInfo: vi.fn().mockResolvedValue({}),
  addStaticDhcpLease: vi.fn().mockResolvedValue({ operationId: "op-6" }),
  rebootRouter: vi.fn().mockResolvedValue({ operationId: "op-7" }),
  getRouterOperation: vi.fn().mockResolvedValue({}),
}));

// The SSID route resolves where the household Wi-Fi actually lives before it
// writes, so a router-radio write can't falsely succeed on the edge-router
// shape (audit 2026-08-06). This suite pins the auth boundary, not that
// resolution, and its prisma mock carries only commandAuditLog — the real
// resolver would reach for `prisma.apDevice` and 500 in front of the RBAC
// assertion. Pin source:"router" (the single-box shape) so the Tier-1 write
// proceeds and the principal check is what's actually under test.
vi.mock("../services/current-wifi.service.js", () => ({
  getCurrentWifi: vi.fn().mockResolvedValue({
    source: "router",
    ssid: "Home",
    key: null,
    detail: "",
    section: null,
    radio: null,
  }),
}));

import { registerWifiRoutes } from "../routes/network-wifi.routes.js";
import { registerFirewallRoutes } from "../routes/network-firewall.routes.js";
import { registerStatusRoutes, type StatusDeps } from "../routes/network-status.routes.js";
import { createNetworkThroughputRouter } from "../routes/network-throughput.js";
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

const mcpPrincipal: AuthUser = {
  id: "_service:mcp",
  username: "_service:mcp",
  displayName: "MCP Server",
  role: "service",
};

const voicePrincipal: AuthUser = {
  id: "_service:voice",
  username: "_service:voice",
  displayName: "Voice Assistant",
  role: "service",
};

const guest: AuthUser = {
  id: "u-guest",
  username: "guest",
  displayName: "guest",
  role: "guest",
};

const owner: AuthUser = {
  id: "u-owner",
  username: "stefan",
  displayName: "stefan",
  role: "owner",
};

function buildApp(user: AuthUser): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  const router = express.Router();
  registerWifiRoutes(router, { prisma: createPrismaMock() });
  registerFirewallRoutes(router, { prisma: createPrismaMock() });
  registerStatusRoutes(router, {
    prisma: createPrismaMock(),
    networkDeviceService: {} as StatusDeps["networkDeviceService"],
  });
  app.use("/api", router);
  // /network/summary lives on its own factory router (network-throughput.ts),
  // mounted at /api exactly like app.ts does.
  app.use(
    "/api",
    createNetworkThroughputRouter({
      networkThroughputSample: { findFirst: vi.fn().mockResolvedValue(null) },
      networkDevice: { count: vi.fn().mockResolvedValue(0) },
      // WARP-468: the summary handler now sums real off-LAN bytes
      // (month-to-date) and DNS-blocked counts (day-to-date). This RBAC
      // test only pins the auth boundary, so null sums (→ 0 in the body)
      // are sufficient — but the delegates must exist or the property
      // access throws and the route 500s before auth is even asserted.
      offLanEgressSample: {
        aggregate: vi.fn().mockResolvedValue({ _sum: { bytes: null } }),
      },
      dnsBlockSample: {
        aggregate: vi.fn().mockResolvedValue({ _sum: { blockedCount: null } }),
      },
    } as unknown as PrismaClient),
  );
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MCP principal on Tier-1 wifi writes", () => {
  it("POST /api/network/wifi/ssid as _service:mcp executes: 200, tier 1", async () => {
    const res = await request(buildApp(mcpPrincipal))
      .post("/api/network/wifi/ssid")
      .send({ ssid: "MyHome" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", ssid: "MyHome", tier: 1 });
    expect(networkService.setWifiSsid).toHaveBeenCalledOnce();
  });

  it("POST /api/network/wifi/channel as _service:mcp executes: 200, tier 1", async () => {
    const res = await request(buildApp(mcpPrincipal))
      .post("/api/network/wifi/channel")
      .send({ channel: "6" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", tier: 1 });
    expect(networkService.setWifiChannel).toHaveBeenCalledOnce();
  });
});

describe("MCP principal on Tier-2 firewall writes — 202 only, never executes", () => {
  it("POST /api/network/firewall/block as _service:mcp mints a confirmation", async () => {
    const res = await request(buildApp(mcpPrincipal))
      .post("/api/network/firewall/block")
      .send({ mac: "aa:bb:cc:dd:ee:ff" });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "confirmation_required",
      operation: "block_device",
      tier: 2,
    });
    expect(res.body.confirmationToken).toBeTruthy();
    expect(networkService.blockDevice).not.toHaveBeenCalled();
  });

  it("POST /api/network/firewall/port-forward as _service:mcp mints a confirmation", async () => {
    const res = await request(buildApp(mcpPrincipal))
      .post("/api/network/firewall/port-forward")
      .send({ name: "ssh", src_port: "2222", dest_ip: "10.0.0.5", dest_port: "22" });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "confirmation_required", tier: 2 });
    expect(networkService.addPortForward).not.toHaveBeenCalled();
  });
});

describe("the guard admits exactly the MCP principal", () => {
  it("another service principal (voice) is still 403", async () => {
    const res = await request(buildApp(voicePrincipal))
      .post("/api/network/wifi/ssid")
      .send({ ssid: "MyHome" });

    expect(res.status).toBe(403);
    expect(networkService.setWifiSsid).not.toHaveBeenCalled();
  });

  it("human RBAC unchanged: guest is still 403", async () => {
    const res = await request(buildApp(guest))
      .post("/api/network/wifi/ssid")
      .send({ ssid: "MyHome" });

    expect(res.status).toBe(403);
    expect(networkService.setWifiSsid).not.toHaveBeenCalled();
  });

  // WARP-1443: the password route is relaxed for the set_wifi_password
  // tool — but it's Tier-2, so the MCP principal only ever mints a 202
  // confirmation and never executes (confirm stays human-only below).
  it("the password route admits _service:mcp: 202 mint, never executes", async () => {
    const res = await request(buildApp(mcpPrincipal))
      .post("/api/network/wifi/password")
      .send({ password: "longenoughpw" });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "confirmation_required",
      operation: "set_wifi_password",
      tier: 2,
    });
    expect(res.body.confirmationToken).toBeTruthy();
    expect(networkService.setWifiPassword).not.toHaveBeenCalled();
  });

  it("other service principals (voice) are still 403 on the password route", async () => {
    const res = await request(buildApp(voicePrincipal))
      .post("/api/network/wifi/password")
      .send({ password: "longenoughpw" });

    expect(res.status).toBe(403);
    expect(networkService.setWifiPassword).not.toHaveBeenCalled();
  });
});

describe("the confirm endpoint never accepts the MCP principal", () => {
  // The "202 only, never executes" invariant above holds only if the
  // principal that mints a token cannot also confirm it —
  // confirmNetworkCommand's user-match check passes when minter and
  // confirmer share an id. Human-only, like /switch/command/confirm.
  it("POST /api/network/command/confirm as _service:mcp is 403", async () => {
    const res = await request(buildApp(mcpPrincipal))
      .post("/api/network/command/confirm")
      .send({ confirmationToken: "tok", operation: "block_device" });

    expect(res.status).toBe(403);
  });

  it("an owner passes the guard (bad token reaches the handler: 400, not 403)", async () => {
    const res = await request(buildApp(owner))
      .post("/api/network/command/confirm")
      .send({ confirmationToken: "no-such-token", operation: "block_device" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TOKEN_MISSING");
  });
});

describe("GET /network/summary admits the MCP principal (network_summary tool)", () => {
  it("_service:mcp gets the KPI rollup: 200", async () => {
    const res = await request(buildApp(mcpPrincipal)).get("/api/network/summary");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ clientCount: 0, lastSampleAt: null });
  });

  it("other service principals (voice) stay 403", async () => {
    const res = await request(buildApp(voicePrincipal)).get("/api/network/summary");

    expect(res.status).toBe(403);
  });
});
