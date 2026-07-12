/**
 * Rolled-up component health monitor (WARP-43).
 *
 * Background-polls each tracked dependency every 15s and caches the latest
 * result. `/api/orchestrator/health` returns the cached snapshot so probes
 * are cheap even when hit from Docker healthchecks + dashboard polling.
 *
 * Classification:
 *   - `ok`       — every component ok
 *   - `degraded` — at least one component down, but no HARD dependency
 *   - `down`     — a HARD dependency is down (postgres) — orchestrator
 *                  cannot meaningfully serve requests
 *
 * Designed so future WARPs can append a new component by adding one entry
 * to COMPONENTS and the rest of the plumbing flows.
 *
 * WARP-618: each poll's results also fan out to generic snapshot observers
 * (`onHealthSnapshot`). This module knows nothing about the consumers —
 * the fleet-analytics bridge subscribes at boot (src/index.ts), keeping the
 * monitor analytics-free by design.
 */

import type { PrismaClient } from "@prisma/client";
import { isRedisHealthy } from "./cache.service.js";
import { healthCheck as aiGatewayHealth } from "./ai-gateway.client.js";
import { healthCheck as routingHealth } from "./openwrt.client.js";
import { healthCheck as displayHealth } from "./display.client.js";
import { healthCheck as fileIndexerHealth } from "./file-indexer.client.js";
import { ncPing } from "./nextcloud.client.js";
import { config } from "../config.js";
import { isBridgeConnectionError } from "../lib/bridge-errors.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("health-monitor");

export type ComponentName =
  | "postgres"
  | "redis"
  | "routing"
  | "ai-gateway"
  | "nextcloud"
  | "display"
  | "file-indexer"
  | "storage";
export type ComponentHealthStatus = "ok" | "down";
export type AggregateStatus = "ok" | "degraded" | "down";

export interface ComponentHealth {
  name: ComponentName;
  status: ComponentHealthStatus;
  latencyMs: number;
  lastCheckedAt: string; // ISO-8601
  error?: string;
}

export interface AggregateHealth {
  status: AggregateStatus;
  components: ComponentHealth[];
  uptime: number; // seconds
  version: string;
}

type Probe = () => Promise<boolean>;

// HARD deps failing → aggregate is `down`. Others failing → `degraded`.
const HARD_DEPS: ReadonlySet<ComponentName> = new Set(["postgres"]);

const POLL_INTERVAL_MS = 15_000;
const PROBE_TIMEOUT_MS = 5_000; // keep probes snappy so the 15s cadence isn't skewed

const startTime = Date.now();
const cache: Map<ComponentName, ComponentHealth> = new Map();
let intervalHandle: NodeJS.Timeout | null = null;

/**
 * WARP-618: per-poll snapshot observers. Every completed probe cycle hands
 * its fresh per-component results to each registered observer. Deliberately
 * GENERIC — this module stays unaware of who is listening (the fleet-
 * analytics bridge subscribes at boot in src/index.ts; anything else can
 * too). An observer that throws is logged and skipped so no consumer can
 * ever break health polling or the /health route it feeds. Subscription
 * lifetime is independent of the poller's start/stop.
 */
export type HealthSnapshotObserver = (
  components: ReadonlyArray<ComponentHealth>,
) => void;

const snapshotObservers = new Set<HealthSnapshotObserver>();

/** Subscribe to every future poll's results. Returns an unsubscribe. */
export function onHealthSnapshot(observer: HealthSnapshotObserver): () => void {
  snapshotObservers.add(observer);
  return () => {
    snapshotObservers.delete(observer);
  };
}

/** Run one probe with a latency measurement and a 5s ceiling. */
async function runProbe(name: ComponentName, probe: Probe): Promise<ComponentHealth> {
  const started = Date.now();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("probe timed out")), PROBE_TIMEOUT_MS),
  );
  try {
    const ok = await Promise.race([probe(), timeout]);
    return {
      name,
      status: ok ? "ok" : "down",
      latencyMs: Date.now() - started,
      lastCheckedAt: new Date().toISOString(),
      error: ok ? undefined : "probe returned false",
    };
  } catch (err) {
    return {
      name,
      status: "down",
      latencyMs: Date.now() - started,
      lastCheckedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * WARP-1146: storage-pool health. A RAID pool that lost a member (degraded)
 * or died (failed) is exactly what the global status pill exists to surface —
 * a home user who never opens Drives must not see a green "All systems
 * operational" over a mirror with no redundancy left.
 *
 * Reads the device-bridge's /pools snapshot (same source the Drives page
 * uses; unauthenticated read like GET /api/storage/pools). `resyncing` counts
 * as ok — the array is actively repairing, and flagging a planned rebuild for
 * hours would train owners to ignore the pill.
 *
 * The device-bridge is host-side and is ONLY installed on single-box installs
 * (scripts/setup.sh gates install-device-bridge.sh behind SINGLE_BOX_MODE). On
 * a multi-box reference shape (ADR-018), or any dev stack, nothing listens at
 * DEVICE_BRIDGE_URL, so the fetch fails with a *connection* error forever. That
 * is an EXPECTED deployment shape — not a fault (lib/bridge-errors.ts
 * `isBridgeConnectionError`) — so we report healthy rather than flipping the
 * global pill to a permanent false "Degraded". The sibling GET /api/storage/pools
 * degrades the same way (`reason: "bridge_unavailable"`). Only a REACHABLE
 * bridge that reports a degraded/failed pool — or that is present but
 * misbehaving (non-ok status, timeout, garbage) — is surfaced as down.
 * Exported for tests.
 */
export async function storagePoolsHealth(): Promise<boolean> {
  // Bound the read so a wedged-but-reachable bridge can't stall the 15s probe
  // cadence (mirrors the AbortController in routes/storage.ts GET /pools).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(`${config.DEVICE_BRIDGE_URL}/pools`, {
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`bridge returned ${r.status}`);
    const snap = (await r.json()) as {
      pools?: Array<{ device?: string; status?: string }>;
    };
    const bad = (snap.pools ?? []).filter(
      (p) => p.status === "degraded" || p.status === "failed",
    );
    if (bad.length > 0) {
      throw new Error(
        bad
          .map((p) => `pool ${p.device ?? "unknown"} is ${p.status}`)
          .join("; "),
      );
    }
    return true;
  } catch (err) {
    // Bridge simply isn't listening (multi-box / dev stack) → an expected
    // shape, not a storage fault: report healthy so the aggregate pill stays
    // green instead of a permanent false "Degraded". A reachable-but-broken
    // bridge (and a real degraded/failed pool) still propagates as down.
    if (isBridgeConnectionError(err)) return true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function buildProbes(prisma: PrismaClient): Array<{ name: ComponentName; probe: Probe }> {
  return [
    {
      name: "postgres",
      probe: async () => {
        await prisma.$queryRaw`SELECT 1`;
        return true;
      },
    },
    { name: "redis", probe: isRedisHealthy },
    { name: "routing", probe: routingHealth },
    { name: "ai-gateway", probe: aiGatewayHealth },
    { name: "nextcloud", probe: ncPing },
    // WARP-165: display is degraded-class only — the service auto-falls
    // back to a `simulated` PNG backend when no status display is plugged
    // in, and the appliance is still usable without a screen, so a down
    // display never trips the aggregate to `down`.
    { name: "display", probe: displayHealth },
    // WARP-598: file-indexer is SOFT (degraded-class). A down indexer
    // only stops new files from being chunked/embedded for semantic
    // search; the rest of the appliance is fully usable, so it never
    // trips the aggregate to `down`.
    { name: "file-indexer", probe: fileIndexerHealth },
    // WARP-1146: storage pools are SOFT (degraded-class) — the box still
    // serves on a degraded mirror; the point is the WARNING pill, not a
    // container restart (`down` would 503 the Docker healthcheck).
    { name: "storage", probe: storagePoolsHealth },
  ];
}

/** Fire every probe in parallel and refresh the cache. Exported for tests. */
export async function runAllProbes(prisma: PrismaClient): Promise<ComponentHealth[]> {
  const probes = buildProbes(prisma);
  const results = await Promise.all(probes.map(({ name, probe }) => runProbe(name, probe)));
  for (const result of results) {
    cache.set(result.name, result);
  }
  for (const observer of snapshotObservers) {
    try {
      observer(results);
    } catch (err) {
      // WARP-618: observers are best-effort consumers — a broken one must
      // never take the poller (or the /health route) down with it.
      logger.warn({ err }, "health snapshot observer threw — skipped");
    }
  }
  return results;
}

/** Classify a set of component results into an aggregate status. Exported for tests. */
export function classifyAggregate(components: ComponentHealth[]): AggregateStatus {
  const downByName: ComponentName[] = components
    .filter((c) => c.status === "down")
    .map((c) => c.name);
  if (downByName.some((n) => HARD_DEPS.has(n))) return "down";
  if (downByName.length > 0) return "degraded";
  return "ok";
}

/** Return the latest cached snapshot (does not trigger a fresh probe). */
export function getAggregateHealth(): AggregateHealth {
  const components = Array.from(cache.values()).sort((a, b) => a.name.localeCompare(b.name));
  return {
    status: classifyAggregate(components),
    components,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: "0.1.0",
  };
}

/**
 * Kick off the background poller. Seeds the cache with one immediate run so
 * the first `/orchestrator/health` hit doesn't return an empty `components`.
 */
export function startHealthMonitor(prisma: PrismaClient): void {
  if (intervalHandle !== null) {
    logger.warn("health monitor already running — ignoring start");
    return;
  }
  // Seed immediately so the first request has a populated snapshot.
  runAllProbes(prisma).catch((err) => {
    logger.warn({ err }, "initial health probe failed");
  });
  intervalHandle = setInterval(() => {
    runAllProbes(prisma).catch((err) => {
      logger.warn({ err }, "health probe cycle failed");
    });
  }, POLL_INTERVAL_MS);
  // Node doesn't exit while an interval is active; unref so tests and graceful
  // shutdown don't hang on this.
  intervalHandle.unref?.();
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "health monitor started");
}

export function stopHealthMonitor(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  cache.clear();
}
