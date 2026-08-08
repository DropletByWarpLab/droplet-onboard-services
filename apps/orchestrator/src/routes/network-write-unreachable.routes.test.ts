/**
 * WARP-807 (K3): network WRITE routes must return 503 + code `UNREACHABLE`
 * (NOT an opaque 500 "Something went wrong") when OpenWrt/routing is
 * unreachable, so the wizard internet/vpn steps can render an actionable
 * message instead of a dead "Internal server error".
 *
 * Route-level coverage for AC #1: drives `POST /network/wifi/ssid` and
 * `POST /network/wifi/password` through the real global `errorHandler`
 * with the service layer stubbed to throw `RouterError.unreachable()`.
 * Asserts the status / code / non-redacted message that the frontend
 * keys off.
 *
 * Auth is injected by a pre-router middleware that sets `req.user` with the
 * `owner` role, so the real `requireRole("owner","admin")` guard passes
 * without standing up Nextcloud token validation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// --- Mocks ---

vi.mock("../config.js", () => ({
  config: {
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    MQTT_BROKER: "mqtt://localhost:1883",
    AI_GATEWAY_URL: "http://localhost:8000",
    PORT: 3000,
    NODE_ENV: "production", // redaction is ON — proves the 503 message survives it
    MAX_UPLOAD_SIZE_MB: 10,
    NEXTCLOUD_URL: "http://nextcloud.test",
    AUTH_ENABLED: false,
    DEVICE_SECRET_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

// The wifi SSID + password routes call evaluateNetworkCommand (safety tier)
// then setWifiSsid / setWifiPassword. Allow the command, then have the writes
// throw UNREACHABLE.
vi.mock("../services/network-safety.service.js", () => ({
  evaluateNetworkCommand: vi.fn().mockResolvedValue({ tier: 1 }),
}));

vi.mock("../services/network.service.js", async () => {
  const { RouterError } = await vi.importActual<any>("../types/router-error.js");
  return {
    setWifiSsid: vi
      .fn()
      .mockRejectedValue(
        RouterError.unreachable("Set SSID: fetch failed", { label: "Set SSID" }),
      ),
    setWifiPassword: vi
      .fn()
      .mockRejectedValue(
        RouterError.unreachable("Set password: fetch failed", {
          label: "Set password",
        }),
      ),
    setWifiChannel: vi.fn(),
    // The SSID route reads the current wireless status before it writes. With
    // routing down that read fails too — the route tolerates it
    // (`.catch(() => null)`) so the write is still the thing that surfaces
    // UNREACHABLE. A bare `vi.fn()` here returns undefined, which would throw a
    // TypeError on `.catch` and mask the 503 behind an opaque 500.
    getWifiSettings: vi
      .fn()
      .mockRejectedValue(
        RouterError.unreachable("Get wifi settings: fetch failed", {
          label: "Get wifi settings",
        }),
      ),
    scanWifiNetworks: vi.fn(),
  };
});

// The SSID route resolves where the household Wi-Fi actually lives before it
// writes, so a router-radio write can't falsely succeed on the edge-router
// shape (audit 2026-08-06). This suite pins the UNREACHABLE error contract, not
// that resolution, and hands the router a `{}` prisma — so pin source:"router"
// (the single-box shape) and let the write be what fails.
vi.mock("../services/current-wifi.service.js", () => ({
  getCurrentWifi: vi.fn().mockResolvedValue({
    source: "router",
    ssid: "MyHomeWifi",
    key: null,
    detail: "",
    section: null,
    radio: null,
  }),
}));

import { errorHandler } from "../middleware/error-handler.js";
import { registerWifiRoutes } from "./network-wifi.routes.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  // Inject an authenticated owner so requireRole(...) passes.
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = {
      id: "u1",
      username: "owner",
      displayName: "Owner",
      role: "owner",
    };
    next();
  });
  const router = express.Router();
  registerWifiRoutes(router, { prisma: {} as never });
  app.use(router);
  app.use(errorHandler);
  return app;
}

describe("network WRITE routes when routing is unreachable (WARP-807)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST /network/wifi/ssid → 503 with code UNREACHABLE and an actionable, non-redacted message", async () => {
    const res = await request(buildApp())
      .post("/network/wifi/ssid")
      .send({ ssid: "MyHomeWifi" });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("UNREACHABLE");
    expect(res.body.message).toBe("Set SSID: fetch failed");
    expect(res.body.message).not.toBe("Something went wrong");
  });

  it("POST /network/wifi/password → 503 with code UNREACHABLE and an actionable, non-redacted message", async () => {
    const res = await request(buildApp())
      .post("/network/wifi/password")
      .send({ password: "hunter2hunter2" });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("UNREACHABLE");
    expect(res.body.message).toBe("Set password: fetch failed");
    expect(res.body.message).not.toBe("Something went wrong");
  });
});
