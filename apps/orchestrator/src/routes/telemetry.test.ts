/**
 * WARP-3504 (ADR-068) — GET /api/telemetry/last: "what this Droplet sends to
 * Warp". Owner and admin only, reads included; every other role, a service
 * principal and an unauthenticated request are refused; the answer is the
 * sender's own snapshot, and nothing else.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

const { getBoxTelemetry } = vi.hoisted(() => ({ getBoxTelemetry: vi.fn() }));
vi.mock("../services/box-telemetry/index.js", () => ({ getBoxTelemetry }));

import { createTelemetryRouter } from "./telemetry.js";

const SNAPSHOT = {
  state: "ok",
  portalHost: "portal.test",
  heartbeatIntervalSec: 300,
  lastAttemptAt: "2026-10-03T12:00:00.000Z",
  lastSuccessAt: "2026-10-03T12:00:00.000Z",
  lastErrorCode: null,
  queued: { heartbeat: 0, events: 0, logs: 0 },
  dropped: 0,
  last: {
    heartbeat: { sentAt: "2026-10-03T12:00:00.000Z", payload: { schema: "heartbeat.v1" } },
    events: null,
    logs: null,
  },
  schemas: [],
  neverSent: ["Anything people type to the assistant"],
  retention: { rawDays: 30, dailySummaryMonths: 13 },
};

function buildApp(role: string | null) {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) (req as any).user = { id: "u-1", username: "u", role };
    next();
  });
  app.use("/api", createTelemetryRouter());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  getBoxTelemetry.mockReturnValue({ snapshot: () => SNAPSHOT });
});

describe("GET /api/telemetry/last", () => {
  it.each(["owner", "admin"])("admits %s and answers with the sender's snapshot", async (role) => {
    const res = await request(buildApp(role)).get("/api/telemetry/last");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(SNAPSHOT);
  });

  it.each(["family", "guest", "service", "nonsense"])("refuses %s with 403, and never asks the sender", async (role) => {
    const res = await request(buildApp(role)).get("/api/telemetry/last");
    expect(res.status).toBe(403);
    expect(getBoxTelemetry).not.toHaveBeenCalled();
  });

  it("refuses a request with no user at all", async () => {
    const res = await request(buildApp(null)).get("/api/telemetry/last");
    expect(res.status).toBe(403);
    expect(getBoxTelemetry).not.toHaveBeenCalled();
  });

  it("is read-only: no write verb exists on the path", async () => {
    for (const verb of ["post", "put", "patch", "delete"] as const) {
      const res = await (request(buildApp("owner")) as any)[verb]("/api/telemetry/last").send({});
      expect(res.status).toBe(404);
    }
  });

  it("before boot wiring it answers as unconfigured instead of failing", async () => {
    getBoxTelemetry.mockReturnValue(null);
    const res = await request(buildApp("admin")).get("/api/telemetry/last");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      state: "unconfigured",
      portalHost: null,
      last: { heartbeat: null, events: null, logs: null },
    });
    expect(res.body.schemas).toHaveLength(3);
  });
});
