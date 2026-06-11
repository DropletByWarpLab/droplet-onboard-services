/**
 * WARP-851 — controller capability surface.
 *
 * The wizard and /devices/add-matter imply every Matter device can be
 * paired, but the controller on the compose bridge network has no BLE
 * (matter.js logs "BLE is not enabled on this platform" at start).
 * GET /api/matter/capabilities exposes that honestly so the dashboard
 * can tell the customer which commissioning paths actually work.
 *
 * Two suites:
 *  1. Route passthrough — mocked service, proves the endpoint shape and
 *     that it answers even before the controller has started (the
 *     capability is environment-derived, not controller-state-derived).
 *  2. Real service derivation — getMatterCapabilities() against the real
 *     matter.js Environment. The test env has no BLE implementation
 *     registered (same as the box), so bleCommissioning must be false.
 *     Mirrors @matter/node NetworkServer.initialize():
 *     `state.ble = env.has(Ble)` — the exact check behind the
 *     "BLE is not enabled on this platform" warning.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    MATTER_STORAGE_PATH: "/tmp/warp-851-matter-test",
    DROPLET_MATTER_CONTROLLER_NAME: "Droplet Test",
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
// derivation itself is under test. The Matter controller is never
// started (getMatterCapabilities is environment-derived).
import { createMatterRouter } from "../routes/matter.js";
import { getMatterCapabilities } from "../services/matter.service.js";
import type { PrismaClient } from "@prisma/client";

describe("getMatterCapabilities (WARP-851)", () => {
  it("reports bleCommissioning=false when no BLE implementation is registered", () => {
    // Same environment shape as the box: @matter/nodejs without a BLE
    // transport registered in Environment.default.
    expect(getMatterCapabilities()).toEqual({ bleCommissioning: false });
  });
});

describe("GET /api/matter/capabilities (WARP-851)", () => {
  function buildApp() {
    const app = express();
    app.use("/api", createMatterRouter({} as unknown as PrismaClient));
    return app;
  }

  it("returns the capability surface even when the controller has not started", async () => {
    const res = await request(buildApp()).get("/api/matter/capabilities");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bleCommissioning: false });
  });
});
