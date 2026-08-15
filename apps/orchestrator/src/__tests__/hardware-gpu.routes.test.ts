/**
 * WARP-1861 — GET /api/hardware/gpu admission + shape.
 *
 * Written because self-review caught this route shipping DEAD: it originally
 * used `requireRole("owner","admin")`, and `get_gpu_status` reaches it through
 * `ctx.http.orchestrator`, which mcp-server stamps with the `_service:mcp`
 * bearer whose role is "service". `requireRole` is a Set membership check, so
 * it 403'd that principal — the tool was registered, advertised to the model,
 * and could never once succeed. cameras.ts:1686 documents the same trap.
 *
 * The other half is shape: the bridge-absent path and the bridge-present path
 * must return the SAME keys, because the tool's description promises the model
 * a consistent object and a missing field reads as "unknown" rather than
 * "unavailable".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    DEVICE_BRIDGE_URL: "http://bridge.test:9090",
    NEXTCLOUD_URL: "http://nextcloud.test",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("pino", () => ({
  default: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

const fetchGpuTelemetry = vi.hoisted(() => vi.fn());
vi.mock("../lib/gpu-telemetry.js", () => ({ fetchGpuTelemetry }));

import { createHardwareRouter } from "../routes/hardware.js";
import type { AuthUser } from "../middleware/auth.js";

function mkUser(role: AuthUser["role"], id: string, username = id): AuthUser {
  return { id, username, displayName: username, role };
}

const MCP = mkUser("service", "_service:mcp", "_service:mcp");
const OWNER = mkUser("owner", "u1", "alice");
const FAMILY = mkUser("family", "u2", "kid");

function buildApp(user: AuthUser) {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createHardwareRouter({} as PrismaClient));
  return app;
}

const SNAPSHOT = {
  available: true,
  card: "card1",
  reason: null,
  busyPercent: 97,
  vramTotalBytes: 17095983104,
  vramUsedBytes: 14190886912,
  vramUsedFraction: 0.83,
  powerWatts: 164,
  tempC: 62,
  processes: [{ pid: 1, comm: "llama-server", cmdline: "x", containerId: "abc123def456" }],
};

beforeEach(() => {
  fetchGpuTelemetry.mockReset();
  fetchGpuTelemetry.mockResolvedValue(SNAPSHOT);
});
afterEach(() => vi.clearAllMocks());

describe("GET /api/hardware/gpu — admission", () => {
  it("admits the _service:mcp principal (the tool's own caller)", async () => {
    // The regression this file exists for. A 403 here means get_gpu_status is
    // advertised to the model and fails 100% of the time.
    const res = await request(buildApp(MCP)).get("/api/hardware/gpu");
    expect(res.status).toBe(200);
    expect(res.body.card).toBe("card1");
  });

  it("still admits a human owner", async () => {
    const res = await request(buildApp(OWNER)).get("/api/hardware/gpu");
    expect(res.status).toBe(200);
  });

  it("refuses a non-privileged household role", async () => {
    // Process command lines are box-internal detail; this is not a
    // family-visible surface.
    const res = await request(buildApp(FAMILY)).get("/api/hardware/gpu");
    expect(res.status).toBe(403);
  });
});

describe("GET /api/hardware/gpu — shape", () => {
  it("returns the same keys when the bridge is absent as when it answers", async () => {
    // The bridge is profile-gated, so absent is ordinary (WARP-645). A payload
    // that drops fields on that path would read as "unknown" to the model
    // rather than "unavailable".
    const present = (await request(buildApp(OWNER)).get("/api/hardware/gpu")).body;
    fetchGpuTelemetry.mockResolvedValue(null);
    const absent = (await request(buildApp(OWNER)).get("/api/hardware/gpu")).body;

    expect(Object.keys(absent).sort()).toEqual(Object.keys(present).sort());
    expect(absent.available).toBe(false);
    expect(absent.reason).toBeTruthy();
    expect(absent.busyPercent).toBeNull();
    expect(absent.processes).toEqual([]);
  });

  it("never 5xxs just because the bridge is down", async () => {
    fetchGpuTelemetry.mockResolvedValue(null);
    const res = await request(buildApp(OWNER)).get("/api/hardware/gpu");
    expect(res.status).toBe(200);
  });

  it("preserves nulls rather than coercing them to 0", async () => {
    // A runtime-suspended card reports nothing readable. 0% would be a claim
    // no one measured, and it passes every threshold check.
    fetchGpuTelemetry.mockResolvedValue({ ...SNAPSHOT, busyPercent: null, tempC: null });
    const res = await request(buildApp(OWNER)).get("/api/hardware/gpu");
    expect(res.body.busyPercent).toBeNull();
    expect(res.body.tempC).toBeNull();
    expect(res.body.available).toBe(true);
  });
});
