/**
 * WARP-1443 — MCP-principal admission on the routes the five new network
 * LLM tools dispatch through:
 *
 *   set_wifi_password   → POST /network/wifi/password        (Tier-2 mint)
 *   set_device_schedule → /network/schedules|overrides|manualBlock writes
 *   list_threat_events  → GET  /activity
 *   get_bandwidth_usage → GET  /network/throughput
 *   list_vpn_peers      → GET  /vpn/peers (admin/full-list view)
 *
 * The tools present the `_service:mcp` principal (role "service"), which
 * plain requireRole 403s — the dead-tool class WARP-1439/1440 fixed for
 * cameras. These tests pin that each widened guard admits exactly that
 * principal while human RBAC stays byte-identical, and that the deliberate
 * exclusions (guest Wi-Fi routes, WARP-1444) stay closed. Scaffolding per
 * cameras-mcp-guards.test.ts: real auth guards, heavy services mocked,
 * req.user-injecting shim.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    SERVICE_SECRET: "svc",
    NEXTCLOUD_URL: "http://nextcloud.test",
    ROUTING_SERVICE_URL: "http://routing.test",
    ROUTING_SERVICE_TOKEN: "test-token",
    ROUTING_MODE: "real",
    WIREGUARD_ENDPOINT_HOST: "vpn.example.com",
    DROPLET_PUBLIC_FQDN: "",
    REMOTE_ACCESS_MODE: "fqdn",
    WIREGUARD_VPN_SUBNET: "10.13.13.0/24",
    WIREGUARD_LISTEN_PORT: 51820,
    WIREGUARD_LAN_CIDR: "192.168.50.0/24",
    WIREGUARD_DNS: "192.168.50.1",
    WIREGUARD_HOME_DNS: "192.168.20.1",
    WIREGUARD_HOME_ALLOWED_IPS: "192.168.20.0/24",
    WIREGUARD_HOME_ENDPOINT_HOST: "",
  },
}));

vi.mock("../services/network.service.js", () => ({
  getWifiSettings: vi.fn(),
  getRadioDetail: vi.fn(),
  scanWifiNetworks: vi.fn(),
  setWifiSsid: vi.fn(),
  setWifiPassword: vi.fn().mockResolvedValue({ operationId: "op-pw" }),
  setWifiChannel: vi.fn(),
  setGuestWifi: vi.fn(),
  getGuestWifi: vi.fn(),
  removeGuestWifi: vi.fn(),
}));

vi.mock("../services/network-safety.service.js", () => ({
  evaluateNetworkCommand: vi.fn(),
  confirmNetworkCommand: vi.fn(),
}));

vi.mock("../services/openwrt.client.js", async () => {
  const actual = await vi.importActual<typeof import("../services/openwrt.client.js")>(
    "../services/openwrt.client.js",
  );
  return {
    ...actual,
    vpnSetup: vi.fn(),
    vpnStatus: vi.fn(),
    createVpnPeer: vi.fn(),
    deleteVpnPeer: vi.fn(),
    fetchNetworkSummary: vi.fn(async () => ({
      wan: { present: false, "ipv4-address": [] },
    })),
  };
});

import { registerWifiRoutes } from "../routes/network-wifi.routes.js";
import { registerScheduleRoutes } from "../routes/network-schedules.routes.js";
import { createActivityRouter } from "../routes/activity.js";
import { createNetworkThroughputRouter } from "../routes/network-throughput.js";
import { createVpnRouter } from "../routes/vpn.js";
import { setWifiPassword, setGuestWifi } from "../services/network.service.js";
import { evaluateNetworkCommand } from "../services/network-safety.service.js";
import type { AuthUser } from "../middleware/auth.js";
import type { createScheduleApiService } from "../services/schedule-api.service.js";

const mockSetWifiPassword = vi.mocked(setWifiPassword);
const mockSetGuestWifi = vi.mocked(setGuestWifi);
const mockEvaluate = vi.mocked(evaluateNetworkCommand);

const mcpPrincipal: AuthUser = {
  id: "_service:mcp", username: "_service:mcp", displayName: "MCP Server", role: "service",
};
const voicePrincipal: AuthUser = {
  id: "_service:voice", username: "_service:voice", displayName: "Voice", role: "service",
};
const owner: AuthUser = {
  id: "u-owner", username: "romain", displayName: "romain", role: "owner",
};
const family: AuthUser = {
  id: "u-family", username: "alice", displayName: "alice", role: "family",
};
const guest: AuthUser = {
  id: "u-guest", username: "guest", displayName: "guest", role: "guest",
};

/** req.user-injecting shim + a mount callback per surface under test. */
function buildApp(user: AuthUser, mount: (app: express.Express) => void): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  mount(app);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSetWifiPassword.mockResolvedValue({ operationId: "op-pw" } as never);
});

// ── set_wifi_password → POST /network/wifi/password ──

function wifiApp(user: AuthUser): express.Express {
  return buildApp(user, (app) => {
    const router = express.Router();
    registerWifiRoutes(router, { prisma: {} as PrismaClient });
    app.use("/api", router);
  });
}

describe("POST /network/wifi/password admits the MCP principal (set_wifi_password)", () => {
  it("_service:mcp reaches the safety layer: Tier-2 202 mint, never executes", async () => {
    mockEvaluate.mockResolvedValue({
      requiresConfirmation: true, confirmationToken: "tok-pw", reason: "tier2", tier: 2,
    } as never);
    const res = await request(wifiApp(mcpPrincipal))
      .post("/api/network/wifi/password")
      .send({ password: "longenoughpw" });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "confirmation_required",
      operation: "set_wifi_password",
      confirmationToken: "tok-pw",
    });
    expect(mockSetWifiPassword).not.toHaveBeenCalled();
  });

  it("human roles unchanged: owner passes the guard, guest is 403", async () => {
    mockEvaluate.mockResolvedValue({
      requiresConfirmation: true, confirmationToken: "tok-pw2", reason: "tier2", tier: 2,
    } as never);
    const ok = await request(wifiApp(owner))
      .post("/api/network/wifi/password")
      .send({ password: "longenoughpw" });
    expect(ok.status).toBe(202);

    const denied = await request(wifiApp(guest))
      .post("/api/network/wifi/password")
      .send({ password: "longenoughpw" });
    expect(denied.status).toBe(403);
    expect(mockEvaluate).toHaveBeenCalledTimes(1);
  });

  it("guest Wi-Fi routes stay closed to _service:mcp (deliberate exclusion, WARP-1444)", async () => {
    const create = await request(wifiApp(mcpPrincipal))
      .post("/api/network/wifi/guest")
      .send({ ssid: "Guests", password: "guestpass123" });
    expect(create.status).toBe(403);
    expect(mockSetGuestWifi).not.toHaveBeenCalled();

    const read = await request(wifiApp(mcpPrincipal)).get("/api/network/wifi/guest");
    expect(read.status).toBe(403);
  });
});

// ── set_device_schedule → schedules / overrides / manualBlock ──

type ScheduleApi = ReturnType<typeof createScheduleApiService>;

function makeScheduleApi() {
  const now = new Date("2026-07-20T10:00:00.000Z");
  const later = new Date("2026-07-20T11:00:00.000Z");
  const override = {
    id: "o1", action: "block", deviceMac: "aa:bb:cc:dd:ee:ff", groupId: null,
    startAt: now, endAt: later,
  };
  return {
    listSchedules: vi.fn().mockResolvedValue([]),
    getSchedule: vi.fn(),
    createSchedule: vi.fn().mockResolvedValue({ id: "s1" }),
    updateSchedule: vi.fn().mockResolvedValue({ id: "s1" }),
    deleteSchedule: vi.fn().mockResolvedValue(undefined),
    listOverrides: vi.fn().mockResolvedValue([]),
    createOverride: vi.fn().mockResolvedValue(override),
    cancelOverride: vi.fn().mockResolvedValue(override),
    listScheduleEvents: vi.fn().mockResolvedValue([]),
    setManualBlock: vi.fn().mockResolvedValue({ mac: "aa:bb:cc:dd:ee:ff", blocked: true }),
  };
}

function scheduleApp(user: AuthUser, api: ReturnType<typeof makeScheduleApi>): express.Express {
  return buildApp(user, (app) => {
    const router = express.Router();
    registerScheduleRoutes(router, { scheduleApi: api as unknown as ScheduleApi });
    app.use("/api", router);
  });
}

describe("schedule write guards admit the MCP principal (set_device_schedule)", () => {
  it("_service:mcp passes every widened schedules/overrides/manualBlock guard", async () => {
    const api = makeScheduleApi();
    const app = scheduleApp(mcpPrincipal, api);

    const created = await request(app).post("/api/network/schedules").send({ name: "Bedtime" });
    expect(created.status).toBe(201);
    expect(api.createSchedule).toHaveBeenCalledOnce();

    const patched = await request(app).patch("/api/network/schedules/s1").send({ name: "x" });
    expect(patched.status).toBe(200);
    expect(api.updateSchedule).toHaveBeenCalledOnce();

    const deleted = await request(app).delete("/api/network/schedules/s1");
    expect(deleted.status).toBe(204);
    expect(api.deleteSchedule).toHaveBeenCalledOnce();

    const override = await request(app).post("/api/network/overrides").send({
      action: "block",
      deviceMac: "aa:bb:cc:dd:ee:ff",
      startAt: "2026-07-20T10:00:00.000Z",
      endAt: "2026-07-20T11:00:00.000Z",
    });
    expect(override.status).toBe(201);
    expect(api.createOverride).toHaveBeenCalledOnce();

    const cancelled = await request(app).delete("/api/network/overrides/o1");
    expect(cancelled.status).toBe(204);
    expect(api.cancelOverride).toHaveBeenCalledOnce();

    const blocked = await request(app)
      .post("/api/network/devices/aa:bb:cc:dd:ee:ff/manualBlock")
      .send({ blocked: true });
    expect(blocked.status).toBe(200);
    expect(api.setManualBlock).toHaveBeenCalledWith("aa:bb:cc:dd:ee:ff", true);
  });

  it("human roles unchanged: owner creates (201), family is denied (403)", async () => {
    const api = makeScheduleApi();

    const ok = await request(scheduleApp(owner, api))
      .post("/api/network/schedules")
      .send({ name: "Bedtime" });
    expect(ok.status).toBe(201);

    const denied = await request(scheduleApp(family, api))
      .post("/api/network/schedules")
      .send({ name: "Bedtime" });
    expect(denied.status).toBe(403);
    expect(api.createSchedule).toHaveBeenCalledTimes(1);
  });
});

// ── list_threat_events → GET /activity ──

function activityApp(user: AuthUser, findMany = vi.fn().mockResolvedValue([])): express.Express {
  const prisma = { activityRow: { findMany } } as unknown as PrismaClient;
  return buildApp(user, (app) => {
    app.use("/api", createActivityRouter(prisma));
  });
}

describe("GET /activity admits the MCP principal (list_threat_events)", () => {
  it("_service:mcp reads the feed: 200, prisma reached", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const res = await request(activityApp(mcpPrincipal, findMany)).get("/api/activity");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
    expect(findMany).toHaveBeenCalledOnce();
  });

  it("human roles unchanged: owner 200, family 403 with the exact legacy body", async () => {
    const ok = await request(activityApp(owner)).get("/api/activity");
    expect(ok.status).toBe(200);

    const denied = await request(activityApp(family)).get("/api/activity");
    expect(denied.status).toBe(403);
    // Byte-identical human behavior: same error body as before WARP-1443.
    expect(denied.body).toEqual({ error: "owner or admin role required" });
  });
});

// ── get_bandwidth_usage → GET /network/throughput ──

function throughputApp(user: AuthUser): express.Express {
  const prisma = {
    networkThroughputSample: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaClient;
  return buildApp(user, (app) => {
    app.use("/api", createNetworkThroughputRouter(prisma));
  });
}

describe("GET /network/throughput admits the MCP principal (get_bandwidth_usage)", () => {
  it("_service:mcp gets the window series: 200", async () => {
    const res = await request(throughputApp(mcpPrincipal))
      .get("/api/network/throughput")
      .query({ window: "1h" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ window: "1h", samples: [] });
  });

  it("human roles unchanged (guest still allowed); other service principals stay 403", async () => {
    const ok = await request(throughputApp(guest)).get("/api/network/throughput");
    expect(ok.status).toBe(200);

    const denied = await request(throughputApp(voicePrincipal)).get("/api/network/throughput");
    expect(denied.status).toBe(403);
  });
});

// ── list_vpn_peers → GET /vpn/peers ──

const peerRows = [
  {
    id: "vp-1", userId: "romain", deviceLabel: "phone", publicKey: "pk-1",
    assignedIp: "10.13.13.2", status: "active", mode: "away",
    createdAt: new Date("2026-07-01T00:00:00.000Z"), revokedAt: null,
  },
  {
    id: "vp-2", userId: "alice", deviceLabel: "laptop", publicKey: "pk-2",
    assignedIp: "10.13.13.3", status: "active", mode: "home",
    createdAt: new Date("2026-07-02T00:00:00.000Z"), revokedAt: null,
  },
];

function vpnApp(user: AuthUser) {
  const findMany = vi.fn(async ({ where }: { where?: { userId?: string } } = {}) => {
    let rows = [...peerRows];
    if (where?.userId) rows = rows.filter((r) => r.userId === where.userId);
    return rows;
  });
  const prisma = { vpnPeer: { findMany } } as unknown as PrismaClient;
  const app = buildApp(user, (a) => {
    a.use("/api", createVpnRouter(prisma));
  });
  return { app, findMany };
}

describe("GET /vpn/peers gives the MCP principal the full list (list_vpn_peers)", () => {
  it("_service:mcp gets the admin (unfiltered) view", async () => {
    const { app, findMany } = vpnApp(mcpPrincipal);
    const res = await request(app).get("/api/vpn/peers");

    expect(res.status).toBe(200);
    expect(res.body.peers).toHaveLength(2);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });

  it("human behavior unchanged: family sees own peers only, owner sees all", async () => {
    const fam = await request(vpnApp(family).app).get("/api/vpn/peers");
    expect(fam.status).toBe(200);
    expect(fam.body.peers).toHaveLength(1);
    expect(fam.body.peers[0].userId).toBe("alice");

    const own = await request(vpnApp(owner).app).get("/api/vpn/peers");
    expect(own.status).toBe(200);
    expect(own.body.peers).toHaveLength(2);
  });

  it("other service principals (voice) still get the self-filtered (empty) view", async () => {
    const { app } = vpnApp(voicePrincipal);
    const res = await request(app).get("/api/vpn/peers");

    expect(res.status).toBe(200);
    expect(res.body.peers).toHaveLength(0);
  });
});
