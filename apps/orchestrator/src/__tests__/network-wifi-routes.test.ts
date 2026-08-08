/**
 * Wi-Fi route ↔ safety-tier name contract (anti-drift).
 *
 * The /network/wifi routes and classifyNetworkCommand are coupled only by
 * bare operation strings, so a rename on either side changes route behavior
 * silently. These tests pin the contract from both ends:
 *
 *  - "set_ssid" / "set_channel" (the SSID + channel route ops) are Tier 1 —
 *    applies immediately, no confirmation arm — per the setup-wizard
 *    contract (docs/SETUP_WIZARD_WALKTHROUGH.md, "Internet" step).
 *  - "set_wifi_password" (the password route op) is Tier 2 and the route
 *    surfaces the 202 confirmation arm.
 *
 * The route-level cases use the REAL network-safety service + rules. The
 * `tier` echo in the SSID response matters: the SSID route has no
 * confirmation arm and only checks `blocked`, so if its operation string
 * ever classified to Tier 2 the route would execute the write unconfirmed
 * and echo tier 2 — which is exactly what the 200-with-tier-1 assertion
 * catches.
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
  getRadioDetail: vi.fn().mockResolvedValue({
    supported: false,
    hostRadio: true,
    broadcasting: true,
    channel: 6,
    htmode: "HT20",
    txpower: 20,
    country: "US",
    mode: "Master",
  }),
  scanWifiNetworks: vi.fn().mockResolvedValue([]),
  setWifiSsid: vi.fn().mockResolvedValue(undefined),
  setWifiPassword: vi.fn().mockResolvedValue({ operationId: "op-1" }),
  setWifiChannel: vi.fn().mockResolvedValue({ operationId: "op-2" }),
}));

// The SSID route resolves where the household Wi-Fi actually lives, to refuse a
// router-radio write when it's really on a separate AP (audit 2026-08-06).
// Default to source:"router" so the immediate-apply cases behave as before;
// the AP-hosted case is overridden per-test.
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
import { classifyNetworkCommand } from "../config/network-safety-rules.js";
import * as networkService from "../services/network.service.js";
import { getCurrentWifi } from "../services/current-wifi.service.js";
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
  app.use("/api", router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("wifi route operation strings classify to the intended tier", () => {
  it('"set_ssid" (the /wifi/ssid route op) is Tier 1 — applies immediately', () => {
    expect(classifyNetworkCommand("set_ssid")).toEqual({
      tier: 1,
      requiresConfirmation: false,
    });
  });

  it('"set_channel" (the /wifi/channel route op) is Tier 1', () => {
    expect(classifyNetworkCommand("set_channel")).toEqual({
      tier: 1,
      requiresConfirmation: false,
    });
  });

  it('"set_wifi_password" (the /wifi/password route op) is Tier 2 — confirmation required', () => {
    const classification = classifyNetworkCommand("set_wifi_password");
    expect(classification.tier).toBe(2);
    expect(classification.requiresConfirmation).toBe(true);
  });
});

describe("wifi routes through the real safety-tier service", () => {
  it("POST /api/network/wifi/ssid applies immediately: 200 with tier 1", async () => {
    const res = await request(buildApp())
      .post("/api/network/wifi/ssid")
      .send({ ssid: "MyHome" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", ssid: "MyHome", tier: 1 });
    expect(networkService.setWifiSsid).toHaveBeenCalledOnce();
  });

  it("POST /api/network/wifi/ssid refuses when the Wi-Fi is on a separate AP (audit 2026-08-06)", async () => {
    // Edge-router shape: the household network is broadcast by an approved AP,
    // so a router-radio write would land nowhere and (before this) falsely
    // report success — the gap that left the set_wifi_ssid MCP tool writing
    // into the void. The route must refuse with a pointer to the AP control.
    vi.mocked(getCurrentWifi).mockResolvedValueOnce({
      source: "ap",
      ssid: "Home",
      key: null,
      detail: "Broadcast by the access point.",
      section: "default_radio0",
      radio: null,
    });

    const res = await request(buildApp())
      .post("/api/network/wifi/ssid")
      .send({ ssid: "MyHome" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "WIFI_ON_ACCESS_POINT" });
    expect(networkService.setWifiSsid).not.toHaveBeenCalled();
  });

  it("POST /api/network/wifi/password requires confirmation: 202 + token, no write", async () => {
    const res = await request(buildApp())
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
});

describe("GET /api/network/wifi/radio (read-only host-radio detail)", () => {
  it("reflects the radio detail envelope from the service", async () => {
    const res = await request(buildApp()).get("/api/network/wifi/radio");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      supported: false,
      hostRadio: true,
      broadcasting: true,
      channel: 6,
      country: "US",
    });
    expect(networkService.getRadioDetail).toHaveBeenCalledOnce();
  });
});
