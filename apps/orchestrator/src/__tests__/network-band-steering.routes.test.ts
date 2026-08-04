/**
 * WARP-1703 — band-steering route ↔ safety-tier contract (anti-drift).
 *
 * The write is Tier 2, NOT set_channel-shaped. The AP-side applier
 * (droplet-edge-router `/etc/init.d/droplet-band-steer`) points
 * `wireless.default_radio1.ssid` at the 2.4 GHz SSID when steering is on and
 * at `<ssid>-5g` when it is off, so a flip RENAMES the 5 GHz network: every
 * device on that band drops and must be reconnected by hand — and the
 * orchestrator fans the write across every ONLINE AP at once. That is the
 * create_guest_network / set_wifi_password cost, not the set_channel one.
 *
 * These pin it from both ends — the operation string classifies to Tier 2
 * with confirmation, and the route answers 202 + token WITHOUT dispatching —
 * plus the read's honesty envelope, body validation, RBAC, and the 422
 * unavailable pass-through.
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
  // wifi route deps
  getWifiSettings: vi.fn().mockResolvedValue({}),
  getRadioDetail: vi.fn().mockResolvedValue({ supported: false }),
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
    supported: true,
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
    getBandSteering: vi.fn().mockResolvedValue({ supported: true, enabled: true }),
    setBandSteering: vi.fn().mockResolvedValue({ operationId: "op-bs" }),
  };
});

import { registerWifiRoutes } from "../routes/network-wifi.routes.js";
import { classifyNetworkCommand } from "../config/network-safety-rules.js";
import * as apOnboardService from "../services/ap-onboard.service.js";
import type { AuthUser } from "../middleware/auth.js";

const getBandSteering = vi.mocked(apOnboardService.getBandSteering);
const setBandSteering = vi.mocked(apOnboardService.setBandSteering);
const { ApOnboardError } = apOnboardService;

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
  getBandSteering.mockResolvedValue({ supported: true, enabled: true });
  setBandSteering.mockResolvedValue({ operationId: "op-bs" });
});

describe("set_ap_band_steering classifies to Tier 2", () => {
  it("requires confirmation — it renames the 5 GHz SSID", () => {
    const c = classifyNetworkCommand("set_ap_band_steering");
    expect(c.tier).toBe(2);
    expect(c.requiresConfirmation).toBe(true);
  });

  it("carries blast-radius copy that names the reconnect cost", () => {
    const c = classifyNetworkCommand("set_ap_band_steering");
    // Not the generic "requires confirmation" fallback — the household has to
    // be told devices drop and won't come back on their own.
    expect(c.reason).toMatch(/reconnect/i);
    expect(c.reason).not.toMatch(/^Network operation/);
  });
});

describe("GET /api/network/wifi/band-steering", () => {
  it("reflects the service's honesty envelope", async () => {
    getBandSteering.mockResolvedValue({ supported: false, enabled: false });
    const res = await request(buildApp()).get("/api/network/wifi/band-steering");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ supported: false, enabled: false });
    expect(getBandSteering).toHaveBeenCalledOnce();
  });

  it("is readable by every household role (matches GET /network/wifi/radio)", async () => {
    const res = await request(buildAppAsRole("family")).get(
      "/api/network/wifi/band-steering",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ supported: true, enabled: true });
  });
});

describe("PUT /api/network/wifi/band-steering", () => {
  it("Tier 2: answers 202 + token and does NOT dispatch the write", async () => {
    const res = await request(buildApp())
      .put("/api/network/wifi/band-steering")
      .send({ enabled: false });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "confirmation_required",
      operation: "set_ap_band_steering",
      tier: 2,
    });
    expect(res.body.confirmationToken).toBeTruthy();
    // The load-bearing assertion: the SSID rename must not have happened yet.
    expect(setBandSteering).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean enabled with 400 and never dispatches", async () => {
    const res = await request(buildApp())
      .put("/api/network/wifi/band-steering")
      .send({ enabled: "yes" });
    expect(res.status).toBe(400);
    expect(setBandSteering).not.toHaveBeenCalled();
  });

  it("rejects a missing body with 400", async () => {
    const res = await request(buildApp())
      .put("/api/network/wifi/band-steering")
      .send({});
    expect(res.status).toBe(400);
    expect(setBandSteering).not.toHaveBeenCalled();
  });

  it("rejects a family member with 403 and never dispatches", async () => {
    const res = await request(buildAppAsRole("family"))
      .put("/api/network/wifi/band-steering")
      .send({ enabled: true });
    expect(res.status).toBe(403);
    expect(setBandSteering).not.toHaveBeenCalled();
  });

  it("admits an admin (202, same confirm arm as the owner)", async () => {
    const res = await request(buildAppAsRole("admin"))
      .put("/api/network/wifi/band-steering")
      .send({ enabled: true });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("confirmation_required");
  });

  // The service's honest 422 (AP_BAND_STEERING_UNAVAILABLE) no longer surfaces
  // here: under Tier 2 the PUT only mints a token and never touches the APs,
  // so an unavailable AP can only be discovered on the confirm path — which is
  // where setBandSteering now runs (network-status.routes.ts). Pinning that the
  // PUT stays 202 even when the service would reject is what stops someone
  // "fixing" the tier by moving the dispatch back into this handler.
  it("still answers 202 — never pre-dispatches to discover a 422", async () => {
    setBandSteering.mockRejectedValue(
      new ApOnboardError(
        "Band steering isn't available — no approved Droplet access point is online.",
        422,
        "AP_BAND_STEERING_UNAVAILABLE",
      ),
    );
    const res = await request(buildApp())
      .put("/api/network/wifi/band-steering")
      .send({ enabled: true });
    expect(res.status).toBe(202);
    expect(setBandSteering).not.toHaveBeenCalled();
  });
});
