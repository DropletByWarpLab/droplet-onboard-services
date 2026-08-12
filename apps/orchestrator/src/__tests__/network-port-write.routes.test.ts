/**
 * Router jack enable/disable route ↔ safety-tier contract (WARP-1907).
 *
 * The physical port map has been read-only since WARP-1866; this is the write
 * half, to the parity the managed switch has had since WARP-1674. Disabling a
 * jack is high blast radius — the WAN jack takes the household offline with no
 * automatic undo — so the write must round-trip through
 * /network/command/confirm (Tier 2) and never apply on the first POST.
 *
 * These pin:
 *   - router_port_enable / router_port_disable classify Tier 2, each with its
 *     OWN blast-radius sentence (turning a jack on and cutting one off are not
 *     the same warning);
 *   - the POST mints a 202 + token and dispatches NO write;
 *   - the operation minted follows `enabled`, so the audit row and the
 *     confirm prompt describe what is about to happen;
 *   - the full 202 → confirm → dispatch path actually reaches the service —
 *     the dispatcher arm the per-route 202 test cannot see;
 *   - `force` is threaded through the token to the service (it is the
 *     acknowledgement the routing guard demands);
 *   - owner/admin only, and NOT the MCP service principal: shutting the jack
 *     the house's internet arrives on is a deliberate human action, the same
 *     call create_interface makes.
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
  createInterface: vi.fn().mockResolvedValue({ operationId: "op-ci" }),
  editInterface: vi.fn().mockResolvedValue({ operationId: "op-ei" }),
  restartNetwork: vi.fn().mockResolvedValue({ operationId: "op-nr" }),
  getFirmwareCheck: vi.fn().mockResolvedValue({}),
  assertPrimaryRouterPosture: vi.fn().mockResolvedValue(undefined),
  PrimaryRouterRequiredError: class PrimaryRouterRequiredError extends Error {},
  routerSysupgrade: vi.fn().mockResolvedValue({ operationId: "op-su" }),
  routerFactoryReset: vi.fn().mockResolvedValue({ operationId: "op-fx" }),
  // under test
  getRouterPorts: vi.fn().mockResolvedValue({
    supported: true,
    detail: null,
    model: "MikroTik RB5009",
    ports: [],
  }),
  setRouterPortEnabled: vi.fn().mockResolvedValue({ operationId: "op-port" }),
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
  return buildAppAsUser({ ...owner, role });
}

function buildAppAsUser(user: AuthUser): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  const prisma = createPrismaMock();
  const router = express.Router();
  registerStatusRoutes(router, { prisma, networkDeviceService: {} as never });
  app.use("/api", router);
  return app;
}

function buildApp(): express.Express {
  return buildAppAsRole("owner");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("port-write operations classify to the right tier", () => {
  it("router_port_disable is Tier 2 with a blast-radius reason", () => {
    const c = classifyNetworkCommand("router_port_disable");
    expect(c.tier).toBe(2);
    expect(c.requiresConfirmation).toBe(true);
    // Not the generic "requires confirmation" fallback.
    expect(c.reason).not.toMatch(/requires confirmation/i);
  });

  it("router_port_enable is Tier 2", () => {
    expect(classifyNetworkCommand("router_port_enable").tier).toBe(2);
  });

  it("the two carry DIFFERENT copy — turning a jack on is not the warning for cutting one off", () => {
    expect(classifyNetworkCommand("router_port_enable").reason).not.toBe(
      classifyNetworkCommand("router_port_disable").reason,
    );
  });
});

describe("POST /api/network/ports/:port/enable", () => {
  it("requires confirmation: 202 + token, no write dispatched", async () => {
    const res = await request(buildApp())
      .post("/api/network/ports/p5/enable")
      .send({ enabled: false });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "confirmation_required",
      operation: "router_port_disable",
      port: "p5",
      tier: 2,
    });
    expect(res.body.confirmationToken).toBeTruthy();
    expect(networkService.setRouterPortEnabled).not.toHaveBeenCalled();
  });

  it("mints the ENABLE operation when the body turns a jack on", async () => {
    const res = await request(buildApp())
      .post("/api/network/ports/p5/enable")
      .send({ enabled: true });
    expect(res.status).toBe(202);
    expect(res.body.operation).toBe("router_port_enable");
  });

  it("rejects a missing 'enabled' with 400 before minting a token", async () => {
    const res = await request(buildApp())
      .post("/api/network/ports/p5/enable")
      .send({});
    expect(res.status).toBe(400);
    expect(networkService.setRouterPortEnabled).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean 'enabled' — a truthy string must not shut a jack", async () => {
    const res = await request(buildApp())
      .post("/api/network/ports/p5/enable")
      .send({ enabled: "false" });
    expect(res.status).toBe(400);
    expect(networkService.setRouterPortEnabled).not.toHaveBeenCalled();
  });

  it("rejects a malformed port name before it reaches the routing service", async () => {
    const res = await request(buildApp())
      .post(`/api/network/ports/${encodeURIComponent("../../etc/passwd")}/enable`)
      .send({ enabled: false });
    expect(res.status).toBe(400);
    expect(networkService.setRouterPortEnabled).not.toHaveBeenCalled();
  });

  it("rejects a family member with 403", async () => {
    const res = await request(buildAppAsRole("family"))
      .post("/api/network/ports/p5/enable")
      .send({ enabled: false });
    expect(res.status).toBe(403);
    expect(networkService.setRouterPortEnabled).not.toHaveBeenCalled();
  });

  it("admin may mint", async () => {
    const res = await request(buildAppAsRole("admin"))
      .post("/api/network/ports/p5/enable")
      .send({ enabled: false });
    expect(res.status).toBe(202);
  });

  it("rejects the MCP service principal — this is never AI-driven", async () => {
    /* Same call `create_interface` makes: rewriting /etc/config/network is a
       deliberate human action. Shutting the jack the household's internet
       arrives on is squarely in that class. */
    const res = await request(
      buildAppAsUser({
        id: "_service:mcp",
        username: "_service:mcp",
        displayName: "MCP",
        role: "service" as AuthUser["role"],
      }),
    )
      .post("/api/network/ports/p5/enable")
      .send({ enabled: false });
    expect(res.status).toBe(403);
    expect(networkService.setRouterPortEnabled).not.toHaveBeenCalled();
  });
});

describe("Tier-2 confirm dispatch reaches the port service", () => {
  it("disable: 202 token confirms and runs setRouterPortEnabled with the staged params", async () => {
    const app = buildApp();
    const minted = await request(app)
      .post("/api/network/ports/p5/enable")
      .send({ enabled: false });
    expect(minted.status).toBe(202);

    const confirmed = await request(app).post("/api/network/command/confirm").send({
      confirmationToken: minted.body.confirmationToken,
      operation: "router_port_disable",
    });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({
      status: "ok",
      operation: "router_port_disable",
      confirmed: true,
    });
    expect(networkService.setRouterPortEnabled).toHaveBeenCalledOnce();
    expect(networkService.setRouterPortEnabled).toHaveBeenCalledWith("p5", false, false);
  });

  it("enable: the confirmed write turns the jack back ON, not off", async () => {
    /* The direction rides the token. If the dispatcher recomputed it, or
       defaulted it, a confirmed "restore my internet" would cut it instead. */
    const app = buildApp();
    const minted = await request(app)
      .post("/api/network/ports/p1/enable")
      .send({ enabled: true });

    await request(app).post("/api/network/command/confirm").send({
      confirmationToken: minted.body.confirmationToken,
      operation: "router_port_enable",
    });

    expect(networkService.setRouterPortEnabled).toHaveBeenCalledWith("p1", true, false);
  });

  it("threads `force` through the token — it is the acknowledgement the routing guard demands", async () => {
    const app = buildApp();
    const minted = await request(app)
      .post("/api/network/ports/p1/enable")
      .send({ enabled: false, force: true });

    await request(app).post("/api/network/command/confirm").send({
      confirmationToken: minted.body.confirmationToken,
      operation: "router_port_disable",
    });

    expect(networkService.setRouterPortEnabled).toHaveBeenCalledWith("p1", false, true);
  });

  it("a token minted WITHOUT force never becomes a forced write", async () => {
    /* `force` is the user's extra acknowledgement. Defaulting it to true on
       replay would silently clear the WAN guard for every confirmed write. */
    const app = buildApp();
    const minted = await request(app)
      .post("/api/network/ports/p1/enable")
      .send({ enabled: false });

    await request(app).post("/api/network/command/confirm").send({
      confirmationToken: minted.body.confirmationToken,
      operation: "router_port_disable",
    });

    expect(networkService.setRouterPortEnabled).toHaveBeenCalledWith("p1", false, false);
  });
});

describe("GET /api/network/ports stays a read", () => {
  it("passes the routing service's map through, disable_guard included", async () => {
    vi.mocked(networkService.getRouterPorts).mockResolvedValueOnce({
      supported: true,
      detail: null,
      model: "MikroTik RB5009",
      ports: [
        {
          id: "p1",
          role: "wan",
          networks: ["wan"],
          present: true,
          admin_up: true,
          link_up: true,
          speed: "2.5 Gb",
          duplex: "full",
          mac: "d0:ea:11:41:67:2c",
          is_sfp: false,
          traffic: null,
          status: "online",
          disable_guard: { code: "WAN_PORT", reason: "…" },
        },
      ],
    });
    const res = await request(buildApp()).get("/api/network/ports");
    expect(res.status).toBe(200);
    expect(res.body.ports[0].disable_guard).toEqual({ code: "WAN_PORT", reason: "…" });
  });
});
