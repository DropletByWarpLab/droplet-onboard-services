/**
 * Degrade-on-outage regression for GET /api/matter/devices.
 *
 * The Devices page polls this endpoint. When the matter-controller sidecar is
 * reachable-but-down at request time (isMatterInitialized() was true from the
 * last health probe, but getCommissionedDevices() now throws a connectivity
 * error), the handler must serve the same empty "disconnected" grouping it
 * already serves for the never-initialized case — a 200, not an unhandled 500
 * (mirrors models-summary.service.ts). Self-heals on the next poll.
 *
 * The matter.service module is mocked so we can force isMatterInitialized()===
 * true (past the early disconnected return) and drive getCommissionedDevices()'s
 * failure shape directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    DROPLET_MATTER_SERVICE_URL: "http://sidecar.test:8083",
    DROPLET_MATTER_SERVICE_TOKEN: "tok-test",
  },
}));

const isMatterInitialized = vi.fn();
const getCommissionedDevices = vi.fn();
vi.mock("../services/matter.service.js", () => ({
  getCommissionedDevices: (...a: unknown[]) => getCommissionedDevices(...a),
  getDevice: vi.fn(),
  sendMatterCommand: vi.fn(),
  discoverDevices: vi.fn(),
  commissionDevice: vi.fn(),
  decommissionDevice: vi.fn(),
  subscribeStateChanges: vi.fn(),
  subscribeConnectionChanges: vi.fn(),
  isMatterInitialized: (...a: unknown[]) => isMatterInitialized(...a),
  getMatterCapabilities: vi.fn(),
}));

vi.mock("../services/safety-tier.service.js", () => ({
  evaluateCommand: vi.fn(),
  confirmCommand: vi.fn(),
  getAuditLog: vi.fn(),
}));

import { createMatterRouter } from "../routes/matter.js";

const DISCONNECTED = {
  lights: [],
  switches: [],
  sensors: [],
  climate: [],
  media: [],
  covers: [],
  locks: [],
  other: [],
  _status: "disconnected",
};

function makeApp() {
  const app = express();
  app.use("/api", createMatterRouter({} as unknown as PrismaClient));
  return app;
}

/** A sidecar-unreachable error: undici "fetch failed" + the socket cause. */
function sidecarDown(): Error {
  const e = new Error("fetch failed");
  (e as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
  return e;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/matter/devices — degrade on sidecar outage", () => {
  it("serves the empty disconnected grouping (200) when the sidecar is unreachable mid-request", async () => {
    isMatterInitialized.mockReturnValue(true);
    getCommissionedDevices.mockRejectedValue(sidecarDown());

    const res = await request(makeApp()).get("/api/matter/devices");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DISCONNECTED);
  });

  it("serves the empty disconnected grouping (200) on a 5xx sidecar response", async () => {
    isMatterInitialized.mockReturnValue(true);
    getCommissionedDevices.mockRejectedValue(
      new Error("matter-controller returned HTTP 503"),
    );

    const res = await request(makeApp()).get("/api/matter/devices");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DISCONNECTED);
  });

  it("still returns the disconnected grouping when never initialized", async () => {
    isMatterInitialized.mockReturnValue(false);

    const res = await request(makeApp()).get("/api/matter/devices");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DISCONNECTED);
    expect(getCommissionedDevices).not.toHaveBeenCalled();
  });

  it("does NOT degrade a real (non-connectivity) error — it still surfaces, not an empty 200", async () => {
    isMatterInitialized.mockReturnValue(true);
    // A plain controller fault with no connectivity signal — must NOT be
    // masked as an empty disconnected payload.
    getCommissionedDevices.mockRejectedValue(
      new Error("controller raised an unexpected internal fault"),
    );

    const res = await request(makeApp()).get("/api/matter/devices");
    expect(res.status).toBe(500);
    expect(res.body).not.toEqual(DISCONNECTED);
  });
});
