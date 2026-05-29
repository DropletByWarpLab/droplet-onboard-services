/**
 * WARP-43: aggregate health classification + /api/orchestrator/health route.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";

vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  saveKey: vi.fn(),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn(),
}));

vi.mock("../services/cache.service.js", () => ({
  connectRedis: vi.fn().mockResolvedValue(undefined),
  isRedisHealthy: vi.fn().mockResolvedValue(true),
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  // WARP-90: passthrough stubs so downstream services that import these
  // from cache.service don't see `undefined is not a function`.
  withSwrCache: vi.fn(
    async (_k: string, _ttl: number, producer: () => Promise<unknown>) =>
      producer(),
  ),
  invalidatePrefix: vi.fn().mockResolvedValue(0),
}));

vi.mock("../services/openwrt.client.js", async () => {
  const actual: any = await vi.importActual("../services/openwrt.client.js");
  return {
    ...actual,
    healthCheck: vi.fn().mockResolvedValue(true),
  };
});

vi.mock("../services/nextcloud.client.js", async () => {
  const actual: any = await vi.importActual("../services/nextcloud.client.js");
  return {
    ...actual,
    ncPing: vi.fn().mockResolvedValue(true),
  };
});

vi.mock("../services/display.client.js", async () => {
  const actual: any = await vi.importActual("../services/display.client.js");
  return {
    ...actual,
    healthCheck: vi.fn().mockResolvedValue(true),
  };
});

import {
  classifyAggregate,
  runAllProbes,
  getAggregateHealth,
  stopHealthMonitor,
  type ComponentHealth,
} from "../services/health-monitor.service.js";
import { createApp } from "../app.js";
import { initDeviceService } from "../services/device.service.js";
import { isRedisHealthy } from "../services/cache.service.js";
import { healthCheck as routingHealth } from "../services/openwrt.client.js";
import { ncPing } from "../services/nextcloud.client.js";
import { healthCheck as aiGatewayHealth } from "../services/ai-gateway.client.js";

function mkComponent(name: any, status: "ok" | "down"): ComponentHealth {
  return {
    name,
    status,
    latencyMs: 5,
    lastCheckedAt: new Date().toISOString(),
  };
}

describe("classifyAggregate (WARP-43)", () => {
  it("all ok → status ok", () => {
    expect(
      classifyAggregate([
        mkComponent("postgres", "ok"),
        mkComponent("redis", "ok"),
        mkComponent("routing", "ok"),
        mkComponent("ai-gateway", "ok"),
        mkComponent("nextcloud", "ok"),
      ]),
    ).toBe("ok");
  });

  it("non-hard dep down → degraded", () => {
    expect(
      classifyAggregate([
        mkComponent("postgres", "ok"),
        mkComponent("redis", "ok"),
        mkComponent("routing", "down"),
        mkComponent("ai-gateway", "ok"),
        mkComponent("nextcloud", "ok"),
      ]),
    ).toBe("degraded");
  });

  it("postgres down → down (hard dep)", () => {
    expect(
      classifyAggregate([
        mkComponent("postgres", "down"),
        mkComponent("redis", "ok"),
        mkComponent("routing", "ok"),
        mkComponent("ai-gateway", "ok"),
        mkComponent("nextcloud", "ok"),
      ]),
    ).toBe("down");
  });

  it("postgres down + others down → still down", () => {
    expect(
      classifyAggregate([
        mkComponent("postgres", "down"),
        mkComponent("redis", "down"),
        mkComponent("routing", "down"),
        mkComponent("ai-gateway", "down"),
        mkComponent("nextcloud", "down"),
      ]),
    ).toBe("down");
  });

  it("empty list → ok (no components, no problems reported)", () => {
    expect(classifyAggregate([])).toBe("ok");
  });
});

describe("runAllProbes (WARP-43)", () => {
  afterEach(() => {
    stopHealthMonitor();
    vi.clearAllMocks();
  });

  it("marks every component ok when all probes succeed", async () => {
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    } as unknown as PrismaClient;

    const results = await runAllProbes(prisma);

    const names = results.map((r) => r.name).sort();
    // WARP-165 added `display` to the probe set (PyPortal sidecar);
    // it's degraded-class only (auto-falls back to a sim backend when
    // /dev/ttyACM* is absent) and never trips the aggregate to down.
    expect(names).toEqual(["ai-gateway", "display", "nextcloud", "postgres", "redis", "routing"]);
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  it("marks postgres down when the SELECT 1 query throws", async () => {
    const prisma = {
      $queryRaw: vi.fn().mockRejectedValue(new Error("connection refused")),
    } as unknown as PrismaClient;

    const results = await runAllProbes(prisma);
    const pg = results.find((r) => r.name === "postgres");

    expect(pg?.status).toBe("down");
    expect(pg?.error).toContain("connection refused");
  });

  it("marks routing down when the probe throws", async () => {
    (routingHealth as any).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;

    const results = await runAllProbes(prisma);
    const routing = results.find((r) => r.name === "routing");

    expect(routing?.status).toBe("down");
  });

  it("marks components down when probes return false", async () => {
    (isRedisHealthy as any).mockResolvedValueOnce(false);
    (ncPing as any).mockResolvedValueOnce(false);
    (aiGatewayHealth as any).mockResolvedValueOnce(false);
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;

    const results = await runAllProbes(prisma);
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));

    expect(byName.redis.status).toBe("down");
    expect(byName.nextcloud.status).toBe("down");
    expect(byName["ai-gateway"].status).toBe("down");
    expect(byName.postgres.status).toBe("ok");
    expect(byName.routing.status).toBe("ok");
  });

  it("latencyMs is a non-negative integer", async () => {
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;

    const results = await runAllProbes(prisma);
    for (const r of results) {
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(r.latencyMs)).toBe(true);
    }
  });
});

describe("GET /api/orchestrator/health", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stopHealthMonitor();
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;
    initDeviceService(prisma);
    app = createApp(prisma);
  });

  afterEach(() => {
    stopHealthMonitor();
    vi.clearAllMocks();
  });

  it("returns the cached snapshot with status + components", async () => {
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;
    await runAllProbes(prisma);

    const res = await request(app).get("/api/orchestrator/health");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status");
    expect(res.body).toHaveProperty("components");
    expect(Array.isArray(res.body.components)).toBe(true);
    expect(res.body.components.length).toBe(6);
    expect(res.body.version).toBe("0.1.0");
    expect(typeof res.body.uptime).toBe("number");
  });

  it("returns 503 when aggregate is down (postgres failure)", async () => {
    const prisma = {
      $queryRaw: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as PrismaClient;
    await runAllProbes(prisma);

    const res = await request(app).get("/api/orchestrator/health");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("down");
  });

  it("returns 200 with status degraded when a non-hard dep is down", async () => {
    (routingHealth as any).mockResolvedValueOnce(false);
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;
    await runAllProbes(prisma);

    const res = await request(app).get("/api/orchestrator/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("degraded");
  });

  it("getAggregateHealth returns empty components list before any probe", () => {
    stopHealthMonitor();
    const snapshot = getAggregateHealth();
    expect(snapshot.components).toEqual([]);
    expect(snapshot.status).toBe("ok");
  });
});
