/**
 * Interface Add / Edit / Restart route ↔ safety-tier contract (KAN-10).
 *
 * Editing an interface is high blast radius — a wrong proto/address/zone can
 * cut the dashboard's own connectivity — so the write must round-trip through
 * the /network/command/confirm dispatcher (Tier 2 for create/edit, Tier 3 for
 * restart), never apply on the first POST. These pin:
 *   - create_interface / edit_interface classify to Tier 2 with a blast-radius
 *     reason; restart_network classifies to Tier 3;
 *   - POST/PUT mint a 202 + token and dispatch NO write;
 *   - the full 202 -> confirm -> dispatch path actually calls the service
 *     (the dispatcher cases the per-route 202 arm can't see);
 *   - the management-interface `force` flag is threaded to the service;
 *   - owner-only; validation rejects junk before any router change.
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
  },
}));

vi.mock("../services/network.service.js", () => ({
  // status-route deps that aren't under test, stubbed so the router builds.
  getNetworkOverview: vi.fn(),
  getConnectedDevices: vi.fn().mockResolvedValue([]),
  getDhcpLeases: vi.fn().mockResolvedValue([]),
  getSystemInfo: vi.fn().mockResolvedValue({}),
  getAllInterfaces: vi.fn().mockResolvedValue([]),
  addStaticDhcpLease: vi.fn().mockResolvedValue({ operationId: "op-sl" }),
  setDnsServers: vi.fn().mockResolvedValue({ operationId: "op-dns" }),
  getTopology: vi.fn().mockResolvedValue({}),
  getDnsHostnames: vi.fn().mockResolvedValue([]),
  addDnsHostname: vi.fn().mockResolvedValue({ operationId: "op-h" }),
  deleteDnsHostname: vi.fn().mockResolvedValue({ operationId: "op-dh" }),
  getDhcpPool: vi.fn().mockResolvedValue({}),
  setDhcpPool: vi.fn().mockResolvedValue({ operationId: "op-pool" }),
  getSystemControls: vi.fn().mockResolvedValue({}),
  setHostname: vi.fn().mockResolvedValue({ operationId: "op-hn" }),
  setNtpEnabled: vi.fn().mockResolvedValue({ operationId: "op-ntp" }),
  blockDevice: vi.fn().mockResolvedValue({ operationId: "op-b" }),
  unblockDevice: vi.fn().mockResolvedValue({ operationId: "op-u" }),
  addPortForward: vi.fn().mockResolvedValue({ operationId: "op-pf" }),
  addFirewallRule: vi.fn().mockResolvedValue({ operationId: "op-fr" }),
  setZonePolicy: vi.fn().mockResolvedValue({ operationId: "op-zp" }),
  setWifiPassword: vi.fn().mockResolvedValue({ operationId: "op-pw" }),
  setGuestWifi: vi.fn().mockResolvedValue({ operationId: "op-g" }),
  setUpnp: vi.fn().mockResolvedValue({ operationId: "op-upnp" }),
  rebootRouter: vi.fn().mockResolvedValue({ operationId: "op-rb" }),
  getRouterOperation: vi.fn(),
  getAiNetworkAccess: vi.fn().mockResolvedValue({}),
  // under test
  createInterface: vi.fn().mockResolvedValue({ operationId: "op-ci" }),
  editInterface: vi.fn().mockResolvedValue({ operationId: "op-ei" }),
  restartNetwork: vi.fn().mockResolvedValue({ operationId: "op-nr" }),
}));

import { registerStatusRoutes } from "../routes/network-status.routes.js";
import { registerInterfaceRoutes } from "../routes/network-interface.routes.js";
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
  const prisma = createPrismaMock();
  const router = express.Router();
  registerInterfaceRoutes(router, { prisma });
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
  registerInterfaceRoutes(router, { prisma });
  registerStatusRoutes(router, { prisma, networkDeviceService: {} as never });
  app.use("/api", router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("interface-write operations classify to the right tier", () => {
  it("create_interface is Tier 2 with a blast-radius reason", () => {
    const c = classifyNetworkCommand("create_interface");
    expect(c.tier).toBe(2);
    expect(c.requiresConfirmation).toBe(true);
  });
  it("edit_interface is Tier 2", () => {
    expect(classifyNetworkCommand("edit_interface").tier).toBe(2);
  });
  it("restart_network is Tier 3 (web-UI-only)", () => {
    const c = classifyNetworkCommand("restart_network");
    expect(c.tier).toBe(3);
    expect(c.requiresConfirmation).toBe(true);
  });
});

describe("POST /api/network/interfaces (create)", () => {
  it("requires confirmation: 202 + token, no write dispatched", async () => {
    const res = await request(buildApp())
      .post("/api/network/interfaces")
      .send({ name: "iot", proto: "static", ipaddr: "192.168.20.1" });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "confirmation_required",
      operation: "create_interface",
      tier: 2,
    });
    expect(res.body.confirmationToken).toBeTruthy();
    expect(networkService.createInterface).not.toHaveBeenCalled();
  });

  it("rejects a missing name with 400 before any router change", async () => {
    const res = await request(buildApp())
      .post("/api/network/interfaces")
      .send({ proto: "dhcp" });
    expect(res.status).toBe(400);
    expect(networkService.createInterface).not.toHaveBeenCalled();
  });

  it("rejects a family member with 403", async () => {
    const res = await request(buildAppAsRole("family"))
      .post("/api/network/interfaces")
      .send({ name: "iot", proto: "dhcp" });
    expect(res.status).toBe(403);
    expect(networkService.createInterface).not.toHaveBeenCalled();
  });
});

describe("PUT /api/network/interfaces/:name (edit)", () => {
  it("requires confirmation: 202 + token, no write dispatched", async () => {
    const res = await request(buildApp())
      .put("/api/network/interfaces/iot")
      .send({ ipaddr: "192.168.20.2" });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "confirmation_required",
      operation: "edit_interface",
      tier: 2,
    });
    expect(networkService.editInterface).not.toHaveBeenCalled();
  });

  it("rejects an empty edit with 400", async () => {
    const res = await request(buildApp())
      .put("/api/network/interfaces/iot")
      .send({});
    expect(res.status).toBe(400);
    expect(networkService.editInterface).not.toHaveBeenCalled();
  });

  it("rejects a family member with 403", async () => {
    const res = await request(buildAppAsRole("family"))
      .put("/api/network/interfaces/iot")
      .send({ ipaddr: "192.168.20.2" });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/network/restart", () => {
  it("requires confirmation: 202 + token, no restart dispatched (Tier 3)", async () => {
    const res = await request(buildApp()).post("/api/network/restart").send({});
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "confirmation_required",
      operation: "restart_network",
      tier: 3,
    });
    expect(networkService.restartNetwork).not.toHaveBeenCalled();
  });

  it("rejects a non-owner admin with 403 (owner-only)", async () => {
    const res = await request(buildAppAsRole("admin")).post("/api/network/restart").send({});
    expect(res.status).toBe(403);
    expect(networkService.restartNetwork).not.toHaveBeenCalled();
  });
});

describe("Tier-2 confirm dispatch reaches the interface service", () => {
  it("create: 202 token confirms and runs createInterface with staged params + force", async () => {
    const app = buildFullApp();
    const minted = await request(app)
      .post("/api/network/interfaces")
      .send({ name: "lan", proto: "static", ipaddr: "192.168.1.1", force: true });
    expect(minted.status).toBe(202);
    const token = minted.body.confirmationToken;

    const confirmed = await request(app)
      .post("/api/network/command/confirm")
      .send({ confirmationToken: token, operation: "create_interface" });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({
      status: "ok",
      operation: "create_interface",
      confirmed: true,
    });
    expect(networkService.createInterface).toHaveBeenCalledOnce();
    expect(networkService.createInterface).toHaveBeenCalledWith({
      name: "lan",
      proto: "static",
      ipaddr: "192.168.1.1",
      netmask: undefined,
      device: undefined,
      gateway: undefined,
      force: true,
    });
  });

  it("edit: 202 token confirms and runs editInterface with staged params", async () => {
    const app = buildFullApp();
    const minted = await request(app)
      .put("/api/network/interfaces/iot")
      .send({ ipaddr: "192.168.20.2" });
    const token = minted.body.confirmationToken;

    const confirmed = await request(app)
      .post("/api/network/command/confirm")
      .send({ confirmationToken: token, operation: "edit_interface" });

    expect(confirmed.status).toBe(200);
    expect(networkService.editInterface).toHaveBeenCalledOnce();
    expect(networkService.editInterface).toHaveBeenCalledWith(
      "iot",
      expect.objectContaining({ ipaddr: "192.168.20.2" }),
    );
  });
});

describe("Tier-3 confirm dispatch reaches restartNetwork", () => {
  it("restart: 202 token confirms and runs restartNetwork", async () => {
    const app = buildFullApp();
    const minted = await request(app).post("/api/network/restart").send({});
    expect(minted.status).toBe(202);
    const token = minted.body.confirmationToken;

    const confirmed = await request(app)
      .post("/api/network/command/confirm")
      .send({ confirmationToken: token, operation: "restart_network" });

    expect(confirmed.status).toBe(200);
    expect(networkService.restartNetwork).toHaveBeenCalledOnce();
  });
});
