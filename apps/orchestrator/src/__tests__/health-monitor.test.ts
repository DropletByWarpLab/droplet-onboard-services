/**
 * WARP-43: aggregate health classification + /api/orchestrator/health route.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
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

vi.mock("../services/file-indexer.client.js", async () => {
  const actual: any = await vi.importActual("../services/file-indexer.client.js");
  return {
    ...actual,
    healthCheck: vi.fn().mockResolvedValue(true),
  };
});

import {
  classifyAggregate,
  runAllProbes,
  getAggregateHealth,
  onHealthSnapshot,
  stopHealthMonitor,
  refreshCurrentVersion,
  type ComponentHealth,
} from "../services/health-monitor.service.js";
import { AnalyticsAgent } from "../services/analytics/agent.js";
import type { AnalyticsClient } from "../services/analytics/client.js";
import { forwardHealthSnapshot } from "../services/analytics/service-health.js";
import { createHealthRouter } from "../routes/health.js";
import { createApp } from "../app.js";
import { initDeviceService } from "../services/device.service.js";
import { isRedisHealthy } from "../services/cache.service.js";
import { healthCheck as routingHealth } from "../services/openwrt.client.js";
import { ncPing } from "../services/nextcloud.client.js";
import { recordMqttState } from "../services/mqtt-status.js";

// WARP-2548: the orchestrator's MQTT client is up unless a test says not.
recordMqttState("connected");
import { healthCheck as aiGatewayHealth } from "../services/ai-gateway.client.js";
import { healthCheck as fileIndexerHealth } from "../services/file-indexer.client.js";

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

/** WARP-1146: the storage probe reads the device-bridge /pools over fetch —
 *  stub it healthy by default so the pre-existing probe tests stay hermetic. */
function stubBridgePools(pools: Array<{ device: string; status: string }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ pools, count: pools.length }),
    }),
  );
}

describe("runAllProbes (WARP-43)", () => {
  beforeEach(() => {
    stubBridgePools([{ device: "md127", status: "active" }]);
  });

  afterEach(() => {
    stopHealthMonitor();
    vi.unstubAllGlobals();
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
    // WARP-598 added `file-indexer` (also degraded-class / SOFT).
    // WARP-1146 added `storage` (SOFT) — a degraded/failed md pool must
    // flip the global pill instead of hiding behind a green "operational".
    expect(names).toEqual([
      "ai-gateway",
      "display",
      "file-indexer",
      "nextcloud",
      "postgres",
      "redis",
      "routing",
      "storage",
      "mqtt",
    ].sort());
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  it("marks storage down when the bridge reports a degraded pool — aggregate degraded, never down (WARP-1146)", async () => {
    stubBridgePools([{ device: "md127", status: "degraded" }]);
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;

    const results = await runAllProbes(prisma);
    const storage = results.find((r) => r.name === "storage");

    expect(storage?.status).toBe("down");
    expect(storage?.error).toMatch(/md127.*degraded/i);
    // Storage is SOFT: the box still serves; the pill goes to warning.
    expect(classifyAggregate(results)).toBe("degraded");
  });

  it("keeps storage ok while a pool is resyncing (repair in progress is not a warning)", async () => {
    stubBridgePools([{ device: "md127", status: "resyncing" }]);
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;

    const results = await runAllProbes(prisma);
    expect(results.find((r) => r.name === "storage")?.status).toBe("ok");
  });

  it("keeps storage ok when the bridge isn't listening — single-box-only device-bridge, so a connection refusal is an expected shape not a fault (WARP-1146 review)", async () => {
    // undici wraps the socket error in `cause` ("fetch failed" + cause.code);
    // isBridgeConnectionError classifies that as an expected-absence, not a
    // fault. A bare Error("ECONNREFUSED") message would NOT be recognised — the
    // classifier keys off cause.code / code, never the message.
    const connErr = new Error("fetch failed");
    (connErr as { cause?: { code?: string } }).cause = { code: "ECONNREFUSED" };
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(connErr));
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;

    const results = await runAllProbes(prisma);
    const storage = results.find((r) => r.name === "storage");
    // The device-bridge only runs on single-box installs; on a multi-box
    // reference shape (ADR-018) or a dev stack nothing listens there. A
    // permanent connection refusal must NOT flip the global pill.
    expect(storage?.status).toBe("ok");
    expect(classifyAggregate(results)).toBe("ok");
  });

  it("marks storage down when the bridge is REACHABLE but errors (present-but-broken is still a real fault, WARP-1146 review)", async () => {
    // A non-ok HTTP reply is a reachable-but-misbehaving bridge — unlike a
    // connection refusal it is not an expected deployment shape, so it stays
    // down (mirrors GET /api/storage/pools returning 502, not bridge_unavailable).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      }),
    );
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;

    const results = await runAllProbes(prisma);
    const storage = results.find((r) => r.name === "storage");
    expect(storage?.status).toBe("down");
    expect(storage?.error).toMatch(/bridge returned 500/i);
    // Storage is SOFT — a down storage component is degraded, never down.
    expect(classifyAggregate(results)).toBe("degraded");
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

  it("marks file-indexer down when the probe throws, and it stays SOFT (degraded)", async () => {
    (fileIndexerHealth as any).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;

    const results = await runAllProbes(prisma);
    const fi = results.find((r) => r.name === "file-indexer");

    expect(fi?.status).toBe("down");
    // file-indexer is a SOFT dependency — a down indexer must not trip
    // the aggregate to `down`.
    expect(classifyAggregate(results)).toBe("degraded");
  });

  it("marks mqtt down WITH the client's last connect error, and it stays SOFT (WARP-2548)", async () => {
    // The incident: the broker crash-looped on an unreadable TLS key and the
    // orchestrator's client could only ever see a refused connection.
    recordMqttState("disconnected", "connect ECONNREFUSED 172.18.0.9:8883");
    recordMqttState("connecting");
    try {
      const results = await runAllProbes({
        $queryRaw: vi.fn().mockResolvedValue([]),
      } as unknown as PrismaClient);
      const mqtt = results.find((r) => r.name === "mqtt");

      expect(mqtt?.status).toBe("down");
      expect(mqtt?.error).toBe("MQTT broker connecting: connect ECONNREFUSED 172.18.0.9:8883");
      expect(classifyAggregate(results)).toBe("degraded");
    } finally {
      recordMqttState("connected");
    }
    // A reconnect clears the stale reason.
    const again = await runAllProbes({
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient);
    expect(again.find((r) => r.name === "mqtt")).toMatchObject({ status: "ok", error: undefined });
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

/** All 9 components the probe set produces today (kept in one place so the
 *  WARP-618 observer tests don't repeat the WARP-43 list assertions). */
const ALL_COMPONENTS = [
  "ai-gateway",
  "display",
  "file-indexer",
  "nextcloud",
  "postgres",
  "redis",
  "routing",
  "storage",
  "mqtt",
].sort();

describe("health snapshot observers (WARP-618)", () => {
  const okPrisma = () =>
    ({ $queryRaw: vi.fn().mockResolvedValue([]) }) as unknown as PrismaClient;

  beforeEach(() => {
    stubBridgePools([{ device: "md127", status: "active" }]);
  });

  afterEach(() => {
    stopHealthMonitor();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("notifies a registered observer with the full per-component results of every poll", async () => {
    const seen: ComponentHealth[][] = [];
    const unsubscribe = onHealthSnapshot((components) =>
      seen.push([...components]),
    );
    try {
      await runAllProbes(okPrisma());
      await runAllProbes(okPrisma());

      expect(seen).toHaveLength(2);
      expect(seen[0].map((c) => c.name).sort()).toEqual(ALL_COMPONENTS);
    } finally {
      unsubscribe();
    }
  });

  it("unsubscribing stops further notifications", async () => {
    const observer = vi.fn();
    const unsubscribe = onHealthSnapshot(observer);
    await runAllProbes(okPrisma());
    unsubscribe();
    await runAllProbes(okPrisma());

    expect(observer).toHaveBeenCalledTimes(1);
  });

  it("a throwing observer never breaks the poll — results still land in the cache", async () => {
    const unsubscribe = onHealthSnapshot(() => {
      throw new Error("observer bug");
    });
    try {
      const results = await runAllProbes(okPrisma());
      expect(results).toHaveLength(ALL_COMPONENTS.length);
      expect(getAggregateHealth().components).toHaveLength(
        ALL_COMPONENTS.length,
      );
    } finally {
      unsubscribe();
    }
  });
});

describe("health polls → fleet analytics, end to end (WARP-618)", () => {
  const okPrisma = () =>
    ({ $queryRaw: vi.fn().mockResolvedValue([]) }) as unknown as PrismaClient;

  /** Real agent (stub wire client) subscribed exactly the way src/index.ts
   *  wires it at boot; its metric/event seams spied so derivation is
   *  observable while still delivering nothing (WARP-617 owns delivery). */
  function attachAnalyticsHarness() {
    const client = {
      postHeartbeat: vi.fn(),
      postMetrics: vi.fn(),
      postEvents: vi.fn(),
      postError: vi.fn(),
    } as unknown as AnalyticsClient;
    const agent = new AnalyticsAgent({ client });
    const metric = vi.spyOn(agent, "metric");
    const event = vi.spyOn(agent, "event");
    const unsubscribe = onHealthSnapshot((snapshot) =>
      forwardHealthSnapshot(snapshot, agent),
    );
    return { agent, metric, event, unsubscribe };
  }

  beforeEach(() => {
    stubBridgePools([{ device: "md127", status: "active" }]);
  });

  afterEach(() => {
    stopHealthMonitor();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("every poll enqueues exactly one service.health metric per component; steady state enqueues zero events", async () => {
    const { metric, event, unsubscribe } = attachAnalyticsHarness();
    try {
      await runAllProbes(okPrisma());

      expect(metric).toHaveBeenCalledTimes(ALL_COMPONENTS.length);
      for (const call of metric.mock.calls) {
        expect(call[0]).toBe("service.health");
        expect(call[1]).toBe(1); // all probes healthy
      }
      const services = metric.mock.calls.map((c) => c[2]?.service).sort();
      expect(services).toEqual(ALL_COMPONENTS);

      // Second all-ok poll: metrics again, still not a single event.
      await runAllProbes(okPrisma());
      expect(metric).toHaveBeenCalledTimes(2 * ALL_COMPONENTS.length);
      expect(event).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("a component flip emits exactly one transition event, holding down stays silent, recovery emits exactly one more", async () => {
    const { event, unsubscribe } = attachAnalyticsHarness();
    try {
      await runAllProbes(okPrisma()); // baseline: all ok, no events

      (isRedisHealthy as any)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);
      await runAllProbes(okPrisma()); // ok → down: one event
      expect(event).toHaveBeenCalledTimes(1);
      expect(event).toHaveBeenCalledWith({
        type: "service.down",
        severity: "error",
        target: "redis",
        payload: {
          latencyMs: expect.any(Number),
          error: "probe returned false",
        },
      });

      await runAllProbes(okPrisma()); // still down: silent
      expect(event).toHaveBeenCalledTimes(1);

      await runAllProbes(okPrisma()); // down → ok: one more
      expect(event).toHaveBeenCalledTimes(2);
      expect(event).toHaveBeenLastCalledWith({
        type: "service.up",
        severity: "info",
        target: "redis",
        payload: { latencyMs: expect.any(Number) },
      });
    } finally {
      unsubscribe();
    }
  });

  it("first-ever snapshot is a baseline: a component already down at boot reports metric 0 but no event", async () => {
    const { metric, event, unsubscribe } = attachAnalyticsHarness();
    try {
      (isRedisHealthy as any).mockResolvedValueOnce(false);
      await runAllProbes(okPrisma());

      expect(event).not.toHaveBeenCalled();
      expect(metric).toHaveBeenCalledWith("service.health", 0, {
        service: "redis",
      });
    } finally {
      unsubscribe();
    }
  });
});

describe("GET /api/orchestrator/health", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stopHealthMonitor();
    // WARP-1146: the storage probe fetches the device-bridge — keep these
    // route tests hermetic (no real network) and healthy by default.
    stubBridgePools([{ device: "md127", status: "active" }]);
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      // BUG-11: requirePasswordChangeGate reads prisma.user.findUnique on
      // every request; null = no directory row = fail-open.
      user: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    initDeviceService(prisma);
    app = createApp(prisma);
  });

  afterEach(() => {
    stopHealthMonitor();
    vi.unstubAllGlobals();
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
    expect(res.body.components.length).toBe(ALL_COMPONENTS.length);
    // WARP-3154 — no `startHealthMonitor` call in this test, so the version
    // never resolved off its default: null, same honest state as a factory-
    // image box. No hardcoded "0.1.0" literal any more.
    expect(res.body.version).toBeNull();
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

  it("WARP-3154: never leaks a down probe's raw error text — the route is unauthenticated", async () => {
    // The storage probe's error names an actual device — exactly the class
    // of internal-topology leak the ticket calls out (a refused connection
    // would name a container IP:port the same way).
    stubBridgePools([{ device: "md127", status: "degraded" }]);
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;
    await runAllProbes(prisma);

    // getAggregateHealth() (used internally, e.g. by other services) still
    // carries the reason — only the public route response is sanitized.
    expect(getAggregateHealth().components.find((c) => c.name === "storage")?.error).toMatch(
      /md127/,
    );

    const res = await request(app).get("/api/orchestrator/health");
    for (const component of res.body.components) {
      expect(component).not.toHaveProperty("error");
    }
    expect(JSON.stringify(res.body)).not.toMatch(/md127/);
    // The rest of the shape is untouched.
    const storage = res.body.components.find((c: { name: string }) => c.name === "storage");
    expect(storage).toMatchObject({ name: "storage", status: "down" });
    expect(typeof storage.latencyMs).toBe("number");
  });
});

describe("GET /api/orchestrator/health/details (WARP-3154 — owner/admin only)", () => {
  // A minimal app around just this router, with a synthetic req.user —
  // the same pattern as routes/access.routes.test.ts's buildApp. This
  // exercises the real `requireRole` guard on the route without needing a
  // live session/JWT through the full authMiddleware stack that
  // createApp() wires up (irrelevant here: the thing under test is the
  // route-level guard, not session resolution).
  function detailsApp(prisma: PrismaClient, role: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { user: { id: string; username: string; role: string } }).user = {
        id: "u1",
        username: "u1",
        role,
      };
      next();
    });
    app.use("/api", createHealthRouter(prisma));
    return app;
  }

  beforeEach(() => {
    stopHealthMonitor();
    stubBridgePools([{ device: "md127", status: "degraded" }]);
  });

  afterEach(() => {
    stopHealthMonitor();
    vi.unstubAllGlobals();
  });

  it.each(["family", "guest", "service"])(
    "403s a %s session — same set the public route now withholds error from",
    async (role) => {
      const prisma = { $queryRaw: vi.fn().mockResolvedValue([]) } as unknown as PrismaClient;
      await runAllProbes(prisma);

      const res = await request(detailsApp(prisma, role)).get("/api/orchestrator/health/details");
      expect(res.status).toBe(403);
    },
  );

  it.each(["owner", "admin"])("gives a %s session the down component's error text", async (role) => {
    const prisma = { $queryRaw: vi.fn().mockResolvedValue([]) } as unknown as PrismaClient;
    await runAllProbes(prisma);

    const res = await request(detailsApp(prisma, role)).get("/api/orchestrator/health/details");
    expect(res.status).toBe(200);
    const storage = res.body.components.find((c: { name: string }) => c.name === "storage");
    expect(storage.error).toMatch(/md127/);
  });
});

describe("refreshCurrentVersion + getAggregateHealth().version (WARP-3154)", () => {
  afterEach(() => {
    stopHealthMonitor();
  });

  it("is null when the box has never taken an OTA update", async () => {
    const prisma = {
      deviceUpdate: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    await refreshCurrentVersion(prisma);
    expect(getAggregateHealth().version).toBeNull();
  });

  it("is the newest committed release's tag", async () => {
    const findFirst = vi.fn().mockResolvedValue({ releaseTag: "ota-stage-42-gabc1234", gitSha: "abc1234" });
    const prisma = { deviceUpdate: { findFirst } } as unknown as PrismaClient;
    await refreshCurrentVersion(prisma);
    expect(getAggregateHealth().version).toBe("ota-stage-42-gabc1234");
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "committed" } }),
    );
  });

  it("falls back to the git sha when a committed row was never tagged", async () => {
    const prisma = {
      deviceUpdate: {
        findFirst: vi.fn().mockResolvedValue({ releaseTag: null, gitSha: "abc1234567890" }),
      },
    } as unknown as PrismaClient;
    await refreshCurrentVersion(prisma);
    expect(getAggregateHealth().version).toBe("git-abc1234567");
  });

  it("keeps the last known version when the DB read fails, rather than resetting to null", async () => {
    const prisma = {
      deviceUpdate: { findFirst: vi.fn().mockResolvedValue({ releaseTag: "ota-stage-9-gdeadbee", gitSha: "deadbee" }) },
    } as unknown as PrismaClient;
    await refreshCurrentVersion(prisma);
    expect(getAggregateHealth().version).toBe("ota-stage-9-gdeadbee");

    const brokenPrisma = {
      deviceUpdate: { findFirst: vi.fn().mockRejectedValue(new Error("connection lost")) },
    } as unknown as PrismaClient;
    await refreshCurrentVersion(brokenPrisma);
    expect(getAggregateHealth().version).toBe("ota-stage-9-gdeadbee");
  });
});
