/**
 * WARP-871 — POST /network/dns route ↔ safety-tier contract.
 *
 * The DNS route fronts the routing /dhcp/dns write. "set_dns" must classify
 * Tier 1 (applies immediately, no confirmation arm) per the network-safety
 * header, and the route must reject a malformed body before any write. Mirrors
 * network-wifi-routes.test.ts: REAL safety service + rules, mocked
 * network.service so no router is touched.
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
  getNetworkOverview: vi.fn(),
  getConnectedDevices: vi.fn().mockResolvedValue([]),
  getDhcpLeases: vi.fn().mockResolvedValue([]),
  getSystemInfo: vi.fn().mockResolvedValue({}),
  addStaticDhcpLease: vi.fn().mockResolvedValue({ operationId: "op-lease" }),
  setDnsServers: vi.fn().mockResolvedValue({ operationId: "op-dns" }),
  getTopology: vi.fn().mockResolvedValue({ posture: "UNKNOWN" }),
  getDnsHostnames: vi
    .fn()
    .mockResolvedValue([{ section: "cfg01", hostname: "nas.lan", ip: "192.168.50.20" }]),
  addDnsHostname: vi.fn().mockResolvedValue({ operationId: null }),
  deleteDnsHostname: vi.fn().mockResolvedValue({ operationId: null }),
  blockDevice: vi.fn().mockResolvedValue({ operationId: null }),
  unblockDevice: vi.fn().mockResolvedValue({ operationId: null }),
  addPortForward: vi.fn().mockResolvedValue({ operationId: null }),
  setWifiPassword: vi.fn().mockResolvedValue({ operationId: null }),
  rebootRouter: vi.fn().mockResolvedValue({ operationId: null }),
  getRouterOperation: vi.fn(),
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

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = owner;
    next();
  });
  const router = express.Router();
  registerStatusRoutes(router, {
    prisma: createPrismaMock(),
    // The DNS route never touches the device service; a bare stub is enough.
    networkDeviceService: { listDevices: vi.fn() } as never,
  });
  app.use("/api", router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /network/dns", () => {
  it('"set_dns" classifies Tier 1 — applies immediately, no confirmation', () => {
    expect(classifyNetworkCommand("set_dns")).toEqual({
      tier: 1,
      requiresConfirmation: false,
    });
  });

  it("applies immediately: 200 with tier 1, forwards the servers", async () => {
    const res = await request(buildApp())
      .post("/api/network/dns")
      .send({ servers: ["1.1.1.1", "8.8.8.8"] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      servers: ["1.1.1.1", "8.8.8.8"],
      tier: 1,
    });
    expect(networkService.setDnsServers).toHaveBeenCalledWith([
      "1.1.1.1",
      "8.8.8.8",
    ]);
  });

  it("rejects an empty server list with 400 and never writes", async () => {
    const res = await request(buildApp())
      .post("/api/network/dns")
      .send({ servers: [] });

    expect(res.status).toBe(400);
    expect(networkService.setDnsServers).not.toHaveBeenCalled();
  });

  it("rejects a non-array body with 400", async () => {
    const res = await request(buildApp())
      .post("/api/network/dns")
      .send({ servers: "1.1.1.1" });

    expect(res.status).toBe(400);
    expect(networkService.setDnsServers).not.toHaveBeenCalled();
  });
});

describe("DNS host-records routes (/network/dhcp/hostnames)", () => {
  it("GET lists the current host-records", async () => {
    const res = await request(buildApp()).get("/api/network/dhcp/hostnames");
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([
      { section: "cfg01", hostname: "nas.lan", ip: "192.168.50.20" },
    ]);
  });

  it("POST adds a host-record: 200 + forwards hostname/ip", async () => {
    const res = await request(buildApp())
      .post("/api/network/dhcp/hostnames")
      .send({ hostname: "printer.lan", ip: "192.168.50.30" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", hostname: "printer.lan" });
    expect(networkService.addDnsHostname).toHaveBeenCalledWith(
      "printer.lan",
      "192.168.50.30",
    );
  });

  it("POST rejects a missing hostname/ip with 400 and never writes", async () => {
    const res = await request(buildApp())
      .post("/api/network/dhcp/hostnames")
      .send({ hostname: "printer.lan" });

    expect(res.status).toBe(400);
    expect(networkService.addDnsHostname).not.toHaveBeenCalled();
  });

  it("DELETE removes a host-record by name", async () => {
    const res = await request(buildApp()).delete(
      "/api/network/dhcp/hostnames/nas.lan",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", hostname: "nas.lan" });
    expect(networkService.deleteDnsHostname).toHaveBeenCalledWith("nas.lan");
  });
});
