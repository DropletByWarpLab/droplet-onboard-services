/**
 * WARP-1761 — `PUT /network/wifi/ap` grows an intent record WITHOUT changing
 * its HTTP contract (ADR-035 §1/§7).
 *
 * This is the failure-1 regression test. Before this ticket the handler
 * pushed straight at the AP; if the AP was unreachable (the lab unit was, for
 * ~20 minutes, during a firmware experiment) the call 502/503'd and the
 * operator's intent was discarded with nothing left to retry. Now the intent
 * is recorded first and SURVIVES the failed push so the converger can apply
 * it later — and the response the dashboard sees is byte-for-byte what it
 * was: same status, same code, same body keys.
 *
 * Route-level on purpose: the contract that must not move is the HTTP one.
 * Auth is injected by a pre-router middleware setting `req.user` with the
 * `owner` role, same as network-write-unreachable.routes.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../config.js", () => ({
  config: {
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    MQTT_BROKER: "mqtt://localhost:1883",
    AI_GATEWAY_URL: "http://localhost:8000",
    PORT: 3000,
    NODE_ENV: "production",
    MAX_UPLOAD_SIZE_MB: 10,
    NEXTCLOUD_URL: "http://nextcloud.test",
    AUTH_ENABLED: false,
    ROUTING_SERVICE_URL: "http://routing.test",
    ROUTING_SERVICE_TOKEN: "test-token",
    ROUTING_MODE: "mock",
    DROPLET_AP_DISCOVERY_INTERVAL: 10,
    DROPLET_AP_APPROVAL_TIMEOUT: 60,
    DROPLET_AP_DAWN_ENABLED: true,
    DROPLET_AP_DEFAULT_TXPOWER: 20,
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

// The routing hop. Everything else in the client stays real so RouterError
// classification is the production one.
vi.mock("../services/openwrt.client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/openwrt.client.js")>();
  return { ...actual, getApWireless: vi.fn(), setApWireless: vi.fn() };
});

// The router-side services the wifi router also mounts — never exercised here.
vi.mock("../services/network.service.js", () => ({
  getWifiSettings: vi.fn(),
  getRadioDetail: vi.fn(),
  scanWifiNetworks: vi.fn(),
  setWifiSsid: vi.fn(),
  setWifiPassword: vi.fn(),
  setWifiChannel: vi.fn(),
  setGuestWifi: vi.fn(),
  getGuestWifi: vi.fn(),
  removeGuestWifi: vi.fn(),
}));

const { evaluateNetworkCommand } = vi.hoisted(() => ({
  evaluateNetworkCommand: vi.fn(),
}));
vi.mock("../services/network-safety.service.js", () => ({ evaluateNetworkCommand }));

import * as openwrt from "../services/openwrt.client.js";
import { errorHandler } from "../middleware/error-handler.js";
import { registerWifiRoutes } from "./network-wifi.routes.js";
import { WIFI_PRIMARY_INTENT_KEY } from "../services/network-intent.service.js";
import { RouterError } from "../types/router-error.js";

const AP_MAC = "AA:BB:CC:DD:EE:01";

/** Prisma stand-in backing ApDevice + NetworkIntent. */
function createPrismaMock(aps: { mac: string; status: string; backend: string }[]) {
  const intentRows = new Map<string, any>();
  return {
    intentRows,
    apDevice: {
      findMany: vi.fn(async ({ where }: any = {}) =>
        aps.filter(
          (a) =>
            (!where?.status || a.status === where.status) &&
            (!where?.backend || a.backend === where.backend),
        ),
      ),
    },
    networkIntent: {
      findUnique: vi.fn(async ({ where }: any) => intentRows.get(where.key) ?? null),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const existing = intentRows.get(where.key);
        const row = existing
          ? {
              ...existing,
              ...update,
              generation:
                update.generation && typeof update.generation === "object"
                  ? existing.generation + update.generation.increment
                  : existing.generation,
            }
          : { ...create };
        intentRows.set(where.key, row);
        return row;
      }),
    },
  };
}

function buildApp(prisma: unknown) {
  const app = express();
  app.use(express.json());
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
  registerWifiRoutes(router, { prisma: prisma as never });
  app.use(router);
  app.use(errorHandler);
  return app;
}

describe("PUT /network/wifi/ap — intent is additive (WARP-1761)", () => {
  const getApWireless = vi.mocked(openwrt.getApWireless);
  const setApWireless = vi.mocked(openwrt.setApWireless);

  beforeEach(() => {
    vi.clearAllMocks();
    evaluateNetworkCommand.mockResolvedValue({ tier: 1 });
    getApWireless.mockResolvedValue({
      supported: true,
      ssid: "Droplet",
      key: "per-unit-psk",
      radios: [],
    });
  });

  it("happy path: records intent AND still pushes, with the response shape unchanged", async () => {
    const prisma = createPrismaMock([
      { mac: AP_MAC, status: "ONLINE", backend: "DROPLET_IMAGE" },
    ]);
    setApWireless.mockResolvedValue({
      operationId: "op-1",
      ssid: "Upstairs",
      five_ghz_ssid: "Upstairs",
    });

    const res = await request(buildApp(prisma))
      .put("/network/wifi/ap")
      .send({ ssid: "Upstairs" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      tier: 1,
      ssid: "Upstairs",
      fiveGhzSsid: "Upstairs",
      operationId: "op-1",
    });
    // The direct push still happened — intent does NOT replace it.
    expect(setApWireless).toHaveBeenCalledWith({ mac: AP_MAC, ssid: "Upstairs" });
    expect(prisma.intentRows.get(WIFI_PRIMARY_INTENT_KEY)).toMatchObject({
      key: "wifi.primary",
      value: { ssid: "Upstairs" },
      generation: 1,
      writtenBy: "u1",
    });
  });

  it("UNREACHABLE push: the HTTP contract is unchanged and the intent SURVIVES", async () => {
    const prisma = createPrismaMock([
      { mac: AP_MAC, status: "ONLINE", backend: "DROPLET_IMAGE" },
    ]);
    setApWireless.mockRejectedValue(
      RouterError.unreachable("AP wireless write: fetch failed", {
        label: "AP wireless write",
      }),
    );

    const res = await request(buildApp(prisma))
      .put("/network/wifi/ap")
      .send({ ssid: "Upstairs" });

    // Exactly today's contract: the route's own ApOnboardError catch.
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("ROUTER_UNREACHABLE");
    expect(Object.keys(res.body).sort()).toEqual(["code", "error"]);

    // …and the write is no longer lost. This is the whole ticket.
    expect(prisma.intentRows.get(WIFI_PRIMARY_INTENT_KEY)).toMatchObject({
      value: { ssid: "Upstairs" },
      generation: 1,
    });
  });

  it("AP offline entirely: still 422, and the intent is still recorded for later", async () => {
    const prisma = createPrismaMock([]); // nothing ONLINE

    const res = await request(buildApp(prisma))
      .put("/network/wifi/ap")
      .send({ ssid: "Upstairs" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("AP_WIRELESS_UNAVAILABLE");
    expect(setApWireless).not.toHaveBeenCalled();
    expect(prisma.intentRows.get(WIFI_PRIMARY_INTENT_KEY)).toMatchObject({
      value: { ssid: "Upstairs" },
      generation: 1,
    });
  });

  it("a Tier-2 202 records NOTHING — intent follows the write, not the token mint", async () => {
    const prisma = createPrismaMock([
      { mac: AP_MAC, status: "ONLINE", backend: "DROPLET_IMAGE" },
    ]);
    evaluateNetworkCommand.mockResolvedValue({
      requiresConfirmation: true,
      tier: 2,
      reason: "Changing the Wi-Fi password disconnects every device",
      confirmationToken: "tok-1",
    });

    const res = await request(buildApp(prisma))
      .put("/network/wifi/ap")
      .send({ ssid: "Upstairs", key: "hunter2hunter2" });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("confirmation_required");
    expect(res.body.operation).toBe("set_ap_wifi_password");
    // Nothing reached the AP, so nothing may claim to be intended yet — the
    // confirm dispatcher's setApWifi call is what records it.
    expect(setApWireless).not.toHaveBeenCalled();
    expect(prisma.intentRows.size).toBe(0);
  });

  it("a blocked command records nothing", async () => {
    const prisma = createPrismaMock([
      { mac: AP_MAC, status: "ONLINE", backend: "DROPLET_IMAGE" },
    ]);
    evaluateNetworkCommand.mockResolvedValue({
      blocked: true,
      tier: 3,
      reason: "Too many pending confirmations",
    });

    const res = await request(buildApp(prisma))
      .put("/network/wifi/ap")
      .send({ ssid: "Upstairs" });

    expect(res.status).toBe(429);
    expect(prisma.intentRows.size).toBe(0);
  });

  it("a rejected payload records nothing — validation still runs first", async () => {
    const prisma = createPrismaMock([
      { mac: AP_MAC, status: "ONLINE", backend: "DROPLET_IMAGE" },
    ]);

    const res = await request(buildApp(prisma))
      .put("/network/wifi/ap")
      .send({ ssid: "x".repeat(33) });

    expect(res.status).toBe(400);
    expect(prisma.intentRows.size).toBe(0);
    expect(evaluateNetworkCommand).not.toHaveBeenCalled();
  });

  // ADR-035 §1: reads still dial the device. The intent store must never
  // become a display cache.
  it("GET /network/wifi/ap never consults intent — it reports the AP's live uci", async () => {
    const prisma = createPrismaMock([
      { mac: AP_MAC, status: "ONLINE", backend: "DROPLET_IMAGE" },
    ]);
    // Intent says one thing…
    prisma.intentRows.set(WIFI_PRIMARY_INTENT_KEY, {
      key: WIFI_PRIMARY_INTENT_KEY,
      value: { ssid: "WHAT-INTENT-WANTS" },
      generation: 9,
    });
    // …the device says another. The device wins, always.
    getApWireless.mockResolvedValue({
      supported: true,
      ssid: "WHAT-THE-AP-ACTUALLY-BROADCASTS",
      key: "per-unit-psk",
      radios: [],
    });
    // Any touch of the intent table on a READ is a hard failure.
    prisma.networkIntent.findUnique.mockImplementation(async () => {
      throw new Error("read path must never consult NetworkIntent (ADR-035 §1)");
    });

    const res = await request(buildApp(prisma)).get("/network/wifi/ap");

    expect(res.status).toBe(200);
    expect(res.body.ssid).toBe("WHAT-THE-AP-ACTUALLY-BROADCASTS");
    expect(res.body.ssid).not.toBe("WHAT-INTENT-WANTS");
  });
});
