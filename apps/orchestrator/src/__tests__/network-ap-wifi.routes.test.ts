/**
 * WARP-1712 — AP Wi-Fi route ↔ safety-tier contract (anti-drift).
 *
 * The founder's ask is that the access point be controllable network
 * infrastructure, with its network name and password driven from the Network
 * tab. These pin the orchestrator's half of that:
 *
 *   * the tier follows the ROUTER's established split rather than a new
 *     posture — a name-only save is `set_ap_wifi_ssid` (Tier 1, applies now,
 *     matching `set_ssid`), a save carrying a passphrase is
 *     `set_ap_wifi_password` (Tier 2, confirm first, matching
 *     `set_wifi_password`), and a save carrying BOTH is evaluated at the
 *     stronger of the two so the confirm covers the whole change;
 *   * the Tier-2 arm answers 202 + token WITHOUT dispatching — nothing
 *     reaches the AP until the confirm;
 *   * validation mirrors services/routing/schemas.py so the box never sees a
 *     payload its hostapd would reject (SSID in BYTES, PSK 8–63);
 *   * the read is owner/admin gated because its body carries the live
 *     passphrase — the guest-PSK posture, NOT the open band-steering read;
 *   * the honest 422 (AP_WIRELESS_UNAVAILABLE) passes through untouched.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

const { configMock } = vi.hoisted(() => ({
  configMock: {
    AUTH_ENABLED: true,
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    DROPLET_AP_MODE: "uci" as "uci" | "hostapd" | "auto",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));
vi.mock("../config.js", () => ({ config: configMock }));

vi.mock("../services/network.service.js", () => ({
  getWifiSettings: vi.fn().mockResolvedValue({}),
  getRadioDetail: vi.fn().mockResolvedValue({ supported: false }),
  scanWifiNetworks: vi.fn().mockResolvedValue([]),
  setWifiSsid: vi.fn().mockResolvedValue(undefined),
  setWifiPassword: vi.fn().mockResolvedValue({ operationId: "op-1" }),
  setWifiChannel: vi.fn().mockResolvedValue({ operationId: "op-2" }),
  setGuestWifi: vi.fn().mockResolvedValue({ operationId: "op-guest" }),
  getGuestWifi: vi.fn().mockResolvedValue({
    configured: false, enabled: false, ssid: null, password: null, supported: true,
  }),
  removeGuestWifi: vi.fn().mockResolvedValue({ operationId: "op-rm" }),
}));

vi.mock("../services/ap-onboard.service.js", () => {
  class ApOnboardError extends Error {
    status: number;
    code: string;
    constructor(message: string, status = 500, code = "UNKNOWN") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApOnboardError,
    getBandSteering: vi.fn().mockResolvedValue({ supported: false, enabled: false }),
    setBandSteering: vi.fn().mockResolvedValue({ operationId: null }),
    getApWifi: vi.fn(),
    setApWifi: vi.fn(),
  };
});

import { registerWifiRoutes } from "../routes/network-wifi.routes.js";
import { classifyNetworkCommand } from "../config/network-safety-rules.js";
import * as apOnboardService from "../services/ap-onboard.service.js";
import type { AuthUser } from "../middleware/auth.js";

const getApWifi = vi.mocked(apOnboardService.getApWifi);
const setApWifi = vi.mocked(apOnboardService.setApWifi);
const { ApOnboardError } = apOnboardService;

const SUPPORTED_STATE = {
  supported: true,
  ssid: "Droplet",
  fiveGhzSsid: "Droplet",
  key: "per-unit-psk",
  encryption: "psk2+ccmp",
  bandSteering: true,
  apCount: 1,
  inSync: true,
};

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
  registerWifiRoutes(router, { prisma: createPrismaMock() });
  app.use("/api", router);
  return app;
}

const buildApp = () => buildAppAsRole("owner");

beforeEach(() => {
  vi.clearAllMocks();
  getApWifi.mockResolvedValue({ ...SUPPORTED_STATE });
  setApWifi.mockResolvedValue({
    operationId: "op-ap", ssid: "Droplet", fiveGhzSsid: "Droplet",
  });
});

describe("safety-tier classification", () => {
  it("set_ap_wifi_ssid is Tier 1 — same as the router's set_ssid", () => {
    const c = classifyNetworkCommand("set_ap_wifi_ssid");
    expect(c.tier).toBe(1);
    expect(c.requiresConfirmation).toBe(false);
  });

  it("set_ap_wifi_password is Tier 2 — same as the router's set_wifi_password", () => {
    const c = classifyNetworkCommand("set_ap_wifi_password");
    expect(c.tier).toBe(2);
    expect(c.requiresConfirmation).toBe(true);
  });

  it("the password blast-radius copy names the reconnect cost", () => {
    const c = classifyNetworkCommand("set_ap_wifi_password");
    expect(c.reason).toMatch(/reconnect/i);
    expect(c.reason).not.toMatch(/^Network operation/);
  });
});

describe("GET /api/network/wifi/ap", () => {
  it("returns the service's live state verbatim", async () => {
    const res = await request(buildApp()).get("/api/network/wifi/ap");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(SUPPORTED_STATE);
  });

  it("passes the honest unsupported envelope through — never an error", async () => {
    getApWifi.mockResolvedValue({
      supported: false, ssid: null, fiveGhzSsid: null, key: null,
      encryption: null, bandSteering: null, apCount: 0, inSync: true,
    });
    const res = await request(buildApp()).get("/api/network/wifi/ap");
    expect(res.status).toBe(200);
    expect(res.body.supported).toBe(false);
  });

  it("reports a split household rather than picking a winner", async () => {
    getApWifi.mockResolvedValue({
      ...SUPPORTED_STATE, ssid: null, inSync: false, apCount: 2,
    });
    const res = await request(buildApp()).get("/api/network/wifi/ap");
    expect(res.status).toBe(200);
    expect(res.body.inSync).toBe(false);
    expect(res.body.ssid).toBeNull();
  });

  // The body carries the live Wi-Fi passphrase, so this read is gated like
  // GET /network/wifi/guest — NOT like the open band-steering read.
  it.each(["family", "guest"] as const)("403s the %s role", async (role) => {
    const res = await request(buildAppAsRole(role)).get("/api/network/wifi/ap");
    expect(res.status).toBe(403);
    expect(getApWifi).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"] as const)("allows the %s role", async (role) => {
    const res = await request(buildAppAsRole(role)).get("/api/network/wifi/ap");
    expect(res.status).toBe(200);
  });
});

describe("PUT /api/network/wifi/ap — tier routing", () => {
  it("applies a name-only save immediately (Tier 1)", async () => {
    const res = await request(buildApp())
      .put("/api/network/wifi/ap")
      .send({ ssid: "Living Room" });
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe(1);
    expect(res.body.operationId).toBe("op-ap");
    // WARP-1761: the authenticated user id rides along as a third argument so
    // the NetworkIntent row this write records carries a truthful `writtenBy`.
    // Additive — the params and the response shape are untouched.
    expect(setApWifi).toHaveBeenCalledWith(
      expect.anything(),
      { ssid: "Living Room", key: undefined },
      "u-owner",
    );
  });

  it("reports the derived 5 GHz name so the operator knows what to rejoin", async () => {
    setApWifi.mockResolvedValue({
      operationId: "op-ap", ssid: "Split", fiveGhzSsid: "Split-5g",
    });
    const res = await request(buildApp())
      .put("/api/network/wifi/ap")
      .send({ ssid: "Split" });
    expect(res.status).toBe(200);
    expect(res.body.ssid).toBe("Split");
    expect(res.body.fiveGhzSsid).toBe("Split-5g");
  });

  it("answers 202 + token for a passphrase change and dispatches NOTHING", async () => {
    const res = await request(buildApp())
      .put("/api/network/wifi/ap")
      .send({ key: "newpassphrase" });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("confirmation_required");
    expect(res.body.operation).toBe("set_ap_wifi_password");
    expect(res.body.tier).toBe(2);
    expect(res.body.confirmationToken).toEqual(expect.any(String));
    // The AP is untouched until the confirm request lands.
    expect(setApWifi).not.toHaveBeenCalled();
  });

  it("evaluates a name+password save at the STRONGER operation", async () => {
    const res = await request(buildApp())
      .put("/api/network/wifi/ap")
      .send({ ssid: "Both", key: "newpassphrase" });
    expect(res.status).toBe(202);
    expect(res.body.operation).toBe("set_ap_wifi_password");
    expect(setApWifi).not.toHaveBeenCalled();
  });
});

describe("PUT /api/network/wifi/ap — validation", () => {
  it("rejects an empty body", async () => {
    const res = await request(buildApp()).put("/api/network/wifi/ap").send({});
    expect(res.status).toBe(400);
    expect(setApWifi).not.toHaveBeenCalled();
  });

  it.each([
    ["", "empty SSID"],
    ["x".repeat(33), "SSID over 32 chars"],
    // 17 characters but 34 BYTES — the 802.11 SSID element is 32 octets, so
    // hostapd would refuse this and take the radios down.
    ["é".repeat(17), "SSID over 32 bytes"],
  ])("rejects %s (%s)", async (ssid) => {
    const res = await request(buildApp()).put("/api/network/wifi/ap").send({ ssid });
    expect(res.status).toBe(400);
    expect(setApWifi).not.toHaveBeenCalled();
  });

  it.each(["short", "x".repeat(64)])("rejects an out-of-range passphrase (%s length)", async (key) => {
    const res = await request(buildApp()).put("/api/network/wifi/ap").send({ key });
    expect(res.status).toBe(400);
    expect(setApWifi).not.toHaveBeenCalled();
  });

  it("accepts the exact boundaries", async () => {
    const res = await request(buildApp())
      .put("/api/network/wifi/ap")
      .send({ ssid: "x".repeat(32) });
    expect(res.status).toBe(200);
  });

  it("rejects non-string fields", async () => {
    const res = await request(buildApp())
      .put("/api/network/wifi/ap")
      .send({ ssid: 42 });
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/network/wifi/ap — RBAC + error pass-through", () => {
  it.each(["family", "guest"] as const)("403s the %s role", async (role) => {
    const res = await request(buildAppAsRole(role))
      .put("/api/network/wifi/ap")
      .send({ ssid: "Nope" });
    expect(res.status).toBe(403);
    expect(setApWifi).not.toHaveBeenCalled();
  });

  it("surfaces AP_WIRELESS_UNAVAILABLE as the service's own 422", async () => {
    setApWifi.mockRejectedValue(
      new ApOnboardError("no AP online", 422, "AP_WIRELESS_UNAVAILABLE"),
    );
    const res = await request(buildApp())
      .put("/api/network/wifi/ap")
      .send({ ssid: "Nope" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("AP_WIRELESS_UNAVAILABLE");
  });

  it("surfaces a routing 502 with its code intact", async () => {
    getApWifi.mockRejectedValue(
      new ApOnboardError("AP unreachable", 502, "ROUTER_UNREACHABLE"),
    );
    const res = await request(buildApp()).get("/api/network/wifi/ap");
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("ROUTER_UNREACHABLE");
  });
});
