/**
 * WARP-851 — controller capability surface.
 * WARP-850 — transport update: the matter.js controller moved into the
 * host-network matter-controller sidecar, so the capability is no
 * longer derived from this process's matter.js Environment —
 * getMatterCapabilities() proxies the sidecar's /capabilities (real
 * BLE transport state, decided once at sidecar process start) and
 * degrades to bleCommissioning=false when the sidecar is unreachable.
 *
 * The ROUTE CONTRACT from WARP-851 is unchanged:
 *   GET /api/matter/capabilities → 200 { bleCommissioning: boolean }
 * answered even before/without the controller being started.
 *
 * Two suites:
 *  1. Real service derivation — getMatterCapabilities() against a
 *     mocked sidecar HTTP surface (pass-through + degrade paths).
 *  2. Route passthrough — proves the endpoint shape and that it answers
 *     while the controller connection is down (degraded answer, not an
 *     error).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    DROPLET_MATTER_SERVICE_URL: "http://sidecar.test:8083",
    DROPLET_MATTER_SERVICE_TOKEN: "tok-warp-850",
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/safety-tier.service.js", () => ({
  evaluateCommand: vi.fn(),
  confirmCommand: vi.fn(),
  getAuditLog: vi.fn(),
}));

// Activity singleton writes Prisma rows — inert here.
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

// NOTE: ../services/matter.service.js is deliberately NOT mocked — the
// router and the test both use the real module so the capability
// proxying itself is under test. Only the sidecar HTTP hop (global
// fetch) is stubbed.
import { createMatterRouter } from "../routes/matter.js";
import { getMatterCapabilities } from "../services/matter.service.js";
import type { PrismaClient } from "@prisma/client";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubSidecarCapabilities(
  handler: () => Response | Promise<Response>,
) {
  const mock = vi.fn(async (url: string | URL) => {
    if (String(url).includes("/capabilities")) return handler();
    throw new Error(`fetch mock: unrouted URL ${String(url)}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("getMatterCapabilities (WARP-851 / WARP-850)", () => {
  it("passes through bleCommissioning=true when the sidecar's BLE transport registered", async () => {
    stubSidecarCapabilities(
      () =>
        new Response(
          JSON.stringify({
            bleCommissioning: true,
            reason: "BLE commissioning enabled on hci0",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    expect(await getMatterCapabilities()).toEqual({ bleCommissioning: true });
  });

  it("reports bleCommissioning=false when the sidecar runs IP-only", async () => {
    stubSidecarCapabilities(
      () =>
        new Response(
          JSON.stringify({
            bleCommissioning: false,
            reason: "no Bluetooth adapter at hci0",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    expect(await getMatterCapabilities()).toEqual({ bleCommissioning: false });
  });

  it("degrades to bleCommissioning=false (never throws) when the sidecar is unreachable", async () => {
    stubSidecarCapabilities(() => {
      throw new Error("ECONNREFUSED");
    });
    expect(await getMatterCapabilities()).toEqual({ bleCommissioning: false });
  });
});

describe("GET /api/matter/capabilities (WARP-851)", () => {
  function buildApp() {
    const app = express();
    app.use("/api", createMatterRouter({} as unknown as PrismaClient));
    return app;
  }

  it("returns the capability surface even when the sidecar connection is down", async () => {
    stubSidecarCapabilities(() => {
      throw new Error("ECONNREFUSED");
    });
    const res = await request(buildApp()).get("/api/matter/capabilities");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bleCommissioning: false });
  });

  it("proxies the sidecar's live answer through the unchanged route contract", async () => {
    stubSidecarCapabilities(
      () =>
        new Response(
          JSON.stringify({
            bleCommissioning: true,
            reason: "BLE commissioning enabled on hci0",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const res = await request(buildApp()).get("/api/matter/capabilities");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bleCommissioning: true });
  });
});
