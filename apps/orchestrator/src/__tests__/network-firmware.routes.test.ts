/**
 * KAN-8 — router firmware upgrade + factory-reset routes (PRIMARY_ROUTER only).
 *
 * THE safety property this ticket exists to prove: `sysupgrade` and
 * `factory_reset` can BRICK the device. On the shipping single-box the OpenWrt
 * runs in a container and a wipe destroys the named-volume UCI the host hostapd
 * bridge depends on, with no remote recovery. So every write route MUST:
 *
 *   (a) refuse on any non-PRIMARY_ROUTER topology BEFORE doing anything else
 *       (no token minted, no service call) — proven first and hardest;
 *   (b) be owner-only (a family/admin caller is rejected);
 *   (c) be Tier-3 (an unconfirmed POST never executes — it mints a token);
 *   (d) only execute after a matching /network/command/confirm.
 *
 * The version-check read is safe on any shape and is NOT gated.
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
    // The pinned firmware image this build ships — the version-check compares
    // the running release against the version embedded in this name.
    ROUTER_FIRMWARE_IMAGE: "openwrt-24.10.0-droplet-squashfs-sysupgrade.img.gz",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/network.service.js", async (importOriginal) => {
  // Keep the REAL PrimaryRouterRequiredError class so `instanceof` checks in the
  // route handler match the error the gate mock rejects with. Everything else is
  // a vi.fn() stub.
  const actual = await importOriginal<typeof import("../services/network.service.js")>();
  return {
  PrimaryRouterRequiredError: actual.PrimaryRouterRequiredError,
  // Unrelated reads/writes the route module imports (kept as no-op mocks).
  getNetworkOverview: vi.fn(),
  getConnectedDevices: vi.fn().mockResolvedValue([]),
  getDhcpLeases: vi.fn().mockResolvedValue([]),
  getSystemInfo: vi.fn().mockResolvedValue({}),
  getAllInterfaces: vi.fn().mockResolvedValue([]),
  addStaticDhcpLease: vi.fn().mockResolvedValue({ operationId: "op-sl" }),
  setDnsServers: vi.fn().mockResolvedValue({ operationId: "op-dns" }),
  getDnsHostnames: vi.fn().mockResolvedValue([]),
  addDnsHostname: vi.fn().mockResolvedValue({ operationId: "op-dh" }),
  deleteDnsHostname: vi.fn().mockResolvedValue({ operationId: "op-dhd" }),
  getDhcpPool: vi.fn().mockResolvedValue({}),
  setDhcpPool: vi.fn().mockResolvedValue({ operationId: "op-pool" }),
  getSystemControls: vi.fn().mockResolvedValue({}),
  setHostname: vi.fn().mockResolvedValue({ operationId: "op-host" }),
  setNtpEnabled: vi.fn().mockResolvedValue({ operationId: "op-ntp" }),
  blockDevice: vi.fn().mockResolvedValue({ operationId: "op-b" }),
  unblockDevice: vi.fn().mockResolvedValue({ operationId: "op-u" }),
  addPortForward: vi.fn().mockResolvedValue({ operationId: "op-pf" }),
  addFirewallRule: vi.fn().mockResolvedValue({ operationId: "op-fw" }),
  setZonePolicy: vi.fn().mockResolvedValue({ operationId: "op-zp" }),
  setWifiPassword: vi.fn().mockResolvedValue({ operationId: "op-pw" }),
  setGuestWifi: vi.fn().mockResolvedValue({ operationId: "op-g" }),
  setUpnp: vi.fn().mockResolvedValue({ operationId: "op-upnp" }),
  rebootRouter: vi.fn().mockResolvedValue({ operationId: "op-rb" }),
  getRouterOperation: vi.fn(),
  getAiNetworkAccess: vi.fn(),
  // Under test (KAN-8).
  getTopology: vi.fn(),
  assertPrimaryRouterPosture: vi.fn(),
  getFirmwareCheck: vi.fn(),
  routerSysupgrade: vi.fn().mockResolvedValue({ operationId: "op-sysup" }),
  routerFactoryReset: vi.fn().mockResolvedValue({ operationId: "op-fr" }),
  };
});

import { registerStatusRoutes } from "../routes/network-status.routes.js";
import { classifyNetworkCommand } from "../config/network-safety-rules.js";
import * as networkService from "../services/network.service.js";
import { PrimaryRouterRequiredError } from "../services/network.service.js";
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
  const router = express.Router();
  registerStatusRoutes(router, { prisma: createPrismaMock(), networkDeviceService: {} as never });
  app.use("/api", router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default posture for the happy paths: a real primary router. The single-box
  // refusal tests override this to make the gate throw.
  vi.mocked(networkService.assertPrimaryRouterPosture).mockResolvedValue(undefined);
  vi.mocked(networkService.routerSysupgrade).mockResolvedValue({ operationId: "op-sysup" });
  vi.mocked(networkService.routerFactoryReset).mockResolvedValue({ operationId: "op-fr" });
});

// ---------------------------------------------------------------------------
// Tier classification (anti-drift)
// ---------------------------------------------------------------------------

describe("firmware op classification", () => {
  it('"sysupgrade" is Tier 3', () => {
    const c = classifyNetworkCommand("sysupgrade");
    expect(c.tier).toBe(3);
    expect(c.requiresConfirmation).toBe(true);
  });

  it('"factory_reset" is Tier 3', () => {
    const c = classifyNetworkCommand("factory_reset");
    expect(c.tier).toBe(3);
    expect(c.requiresConfirmation).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (a) THE safety property: refuse on non-PRIMARY_ROUTER shapes
// ---------------------------------------------------------------------------

describe("single-box / non-PRIMARY_ROUTER refusal", () => {
  function makeGateRefuse(posture: string) {
    vi.mocked(networkService.assertPrimaryRouterPosture).mockRejectedValue(
      new PrimaryRouterRequiredError(posture),
    );
  }

  it("POST /sysupgrade refuses with 409 on the single-box (UNKNOWN posture) and mints NO token", async () => {
    makeGateRefuse("UNKNOWN");
    const res = await request(buildApp())
      .post("/api/network/system/sysupgrade")
      .send({ imagePath: "/tmp/img.gz" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PRIMARY_ROUTER_REQUIRED");
    // No token minted, no flash dispatched — the gate ran FIRST.
    expect(res.body.confirmationToken).toBeUndefined();
    expect(networkService.routerSysupgrade).not.toHaveBeenCalled();
  });

  it("POST /factory-reset refuses with 409 on a DOWNSTREAM_ROUTER and dispatches nothing", async () => {
    makeGateRefuse("DOWNSTREAM_ROUTER");
    const res = await request(buildApp()).post("/api/network/system/factory-reset").send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PRIMARY_ROUTER_REQUIRED");
    expect(networkService.routerFactoryReset).not.toHaveBeenCalled();
  });

  it("the confirm dispatcher ALSO re-checks posture: a confirmed token cannot flash a single-box", async () => {
    // Mint a token while the box LOOKS like a primary router...
    const app = buildFullApp();
    const minted = await request(app)
      .post("/api/network/system/sysupgrade")
      .send({ imagePath: "/tmp/img.gz" });
    expect(minted.status).toBe(202);
    const token = minted.body.confirmationToken;

    // ...then the posture flips (or was always single-box) by confirm time.
    makeGateRefuse("UNKNOWN");
    const confirmed = await request(app)
      .post("/api/network/command/confirm")
      .send({ confirmationToken: token, operation: "sysupgrade" });

    expect(confirmed.status).toBe(409);
    expect(confirmed.body.code).toBe("PRIMARY_ROUTER_REQUIRED");
    expect(networkService.routerSysupgrade).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (b) owner-only
// ---------------------------------------------------------------------------

describe("owner-only", () => {
  it("rejects an admin from POST /sysupgrade with 403", async () => {
    const res = await request(buildAppAsRole("admin"))
      .post("/api/network/system/sysupgrade")
      .send({ imagePath: "/tmp/img.gz" });
    expect(res.status).toBe(403);
    expect(networkService.routerSysupgrade).not.toHaveBeenCalled();
  });

  it("rejects a family member from POST /factory-reset with 403", async () => {
    const res = await request(buildAppAsRole("family"))
      .post("/api/network/system/factory-reset")
      .send({});
    expect(res.status).toBe(403);
    expect(networkService.routerFactoryReset).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (c) Tier-3 confirm required — unconfirmed POST never executes
// ---------------------------------------------------------------------------

describe("Tier-3 confirm required", () => {
  it("POST /sysupgrade mints a 202 + token and dispatches NO flash", async () => {
    const res = await request(buildApp())
      .post("/api/network/system/sysupgrade")
      .send({ imagePath: "/tmp/openwrt-24.10.0-sysupgrade.img.gz" });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "confirmation_required", operation: "sysupgrade", tier: 3 });
    expect(res.body.confirmationToken).toBeTruthy();
    expect(networkService.routerSysupgrade).not.toHaveBeenCalled();
  });

  it("POST /factory-reset mints a 202 + token and wipes NOTHING", async () => {
    const res = await request(buildApp()).post("/api/network/system/factory-reset").send({});
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "confirmation_required", operation: "factory_reset", tier: 3 });
    expect(res.body.confirmationToken).toBeTruthy();
    expect(networkService.routerFactoryReset).not.toHaveBeenCalled();
  });

  it("an AI-sourced sysupgrade is hard-blocked (never even via a token)", async () => {
    // The mint route admits humans only (owner). There is intentionally no
    // requireRoleOrMcpService variant, so the agent principal can't reach it —
    // the route guard 403s it before classification. This pins that the route
    // is human-only by construction.
    const res = await request(buildAppAsRole("admin"))
      .post("/api/network/system/sysupgrade")
      .send({ imagePath: "/tmp/img.gz" });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// (d) full confirm -> dispatch path
// ---------------------------------------------------------------------------

describe("confirm -> dispatch", () => {
  it("sysupgrade: 202 -> confirm runs routerSysupgrade with the staged image", async () => {
    const app = buildFullApp();
    const minted = await request(app)
      .post("/api/network/system/sysupgrade")
      .send({ imagePath: "/tmp/openwrt-24.10.0-sysupgrade.img.gz", preserveConfig: false });
    expect(minted.status).toBe(202);

    const confirmed = await request(app)
      .post("/api/network/command/confirm")
      .send({ confirmationToken: minted.body.confirmationToken, operation: "sysupgrade" });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ status: "ok", operation: "sysupgrade", confirmed: true });
    expect(networkService.routerSysupgrade).toHaveBeenCalledWith(
      "/tmp/openwrt-24.10.0-sysupgrade.img.gz",
      false,
    );
  });

  it("factory_reset: 202 -> confirm runs routerFactoryReset", async () => {
    const app = buildFullApp();
    const minted = await request(app).post("/api/network/system/factory-reset").send({});
    expect(minted.status).toBe(202);

    const confirmed = await request(app)
      .post("/api/network/command/confirm")
      .send({ confirmationToken: minted.body.confirmationToken, operation: "factory_reset" });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ status: "ok", operation: "factory_reset", confirmed: true });
    expect(networkService.routerFactoryReset).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// version-check read (AC 4) — safe on any shape, NOT gated
// ---------------------------------------------------------------------------

describe("GET /network/system/firmware-check", () => {
  it("returns the compare result and is reachable on a single-box (not gated)", async () => {
    vi.mocked(networkService.getFirmwareCheck).mockResolvedValue({
      currentVersion: "23.05.5",
      pinnedVersion: "24.10.0",
      upToDate: false,
      upgradeAvailable: true,
    });
    const res = await request(buildApp()).get("/api/network/system/firmware-check");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      currentVersion: "23.05.5",
      pinnedVersion: "24.10.0",
      upToDate: false,
      upgradeAvailable: true,
    });
    // A read must never run the PRIMARY_ROUTER gate.
    expect(networkService.assertPrimaryRouterPosture).not.toHaveBeenCalled();
  });
});
