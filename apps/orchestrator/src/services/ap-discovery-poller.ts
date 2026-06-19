/**
 * WARP-446 — AP discovery poller (blocker #1 fix-up).
 *
 * Wires the orchestrator-side discovery loop required by ADR-005 §1. On
 * every tick the poller drives the ADR-024 Phase-2 discovery multiplexer
 * (ap-discovery-multiplexer.ts), which fans out every ENABLED discovery
 * source, merges their snapshots, and reconciles them in one pass.
 *
 * The live source is mDNS: it queries the routing service's
 * `/aps/discovered` endpoint (parsed `umdns browse` output filtered to
 * `_droplet-ap._tcp` records on a real router; the in-memory seed list on
 * the mock router) and tags every observation `DROPLET_IMAGE`. The
 * EasyMesh / UniFi sources are gated behind `DROPLET_AP_EASYMESH_ENABLED`
 * / `DROPLET_AP_UNIFI_ENABLED` (both default off) — when off, which is the
 * default single-box config, they contribute nothing and the path is
 * byte-for-byte the Phase-1 mDNS behavior. Merged observations are fed
 * into `reconcileDiscovered()` which owns the state-machine transitions —
 * brand-new MACs land in AWAITING_APPROVAL; existing rows just bump
 * `lastSeen` + any new fields.
 *
 * Same shape as `device-reconcile-poller.ts`: narrow `OpenwrtClient`
 * surface so tests can inject in-memory mocks without pulling the whole
 * module. Failures degrade to a logged no-op — missing one 10s window
 * of discovery is fine, the next tick recovers.
 *
 * Wired in `index.ts` via `createCronRuntime(...).scheduleInterval(...)`
 * at the `DROPLET_AP_DISCOVERY_INTERVAL`-second cadence so AC #1
 * ("AWAITING_APPROVAL within 30 s of plug-in") is met by default (10 s
 * cadence × 3-tick budget). There is exactly ONE scheduler for discovery
 * (ADR-024 §6 — no second poller, no `while True`).
 */
import pino from "pino";
import type { PrismaClient } from "@prisma/client";
import { logRouterError } from "./openwrt.client.js";
import type { CronRuntime } from "./cron-runtime.service.js";
import {
  createDiscoveryMultiplexer,
  MdnsDiscoverySource,
  EasyMeshDiscoverySource,
  UniFiDiscoverySource,
  type DiscoverySource,
} from "./ap-discovery-multiplexer.js";
import { createUniFiNetworkClient } from "./unifi-network.client.js";

const logger = pino({ name: "ap-discovery-poller" });

/**
 * Narrow surface of the openwrt client the mDNS source needs. Mirrors the
 * `DiscoveredApInfo` shape coming off `/aps/discovered`. Kept loose
 * (snake_case keys + optional fields) so the mapping to
 * `DiscoveredApObservation` happens at the source boundary, not at the
 * routing-client layer.
 */
export interface ApDiscoveryOpenwrtClient {
  listDiscoveredAps(): Promise<
    Array<{
      mac: string;
      model?: string;
      serial?: string;
      version?: string;
      last_ip?: string;
      hostname?: string;
    }>
  >;
}

/**
 * ADR-024 §5 backend feature flags. Both default OFF so the shipping
 * single-box path is unchanged; the poller registers the EasyMesh / UniFi
 * scaffolds only when their flag is on (and even when on, this phase they
 * yield []).
 */
export interface ApDiscoveryBackendFlags {
  easymeshEnabled?: boolean;
  unifiEnabled?: boolean;
}

export interface ApDiscoveryPoller {
  /**
   * Pull the discovered-AP list from the routing service once and
   * reconcile against `ApDevice`. Never throws — same belt-and-suspenders
   * contract as `device-reconcile-poller.pollOnce()`.
   */
  pollOnce(): Promise<void>;
}

export function createApDiscoveryPoller(
  prisma: PrismaClient,
  openwrt: ApDiscoveryOpenwrtClient,
  flags: ApDiscoveryBackendFlags = {},
): ApDiscoveryPoller {
  // Assemble the enabled discovery sources for the multiplexer. The mDNS
  // source is always live (DROPLET_IMAGE); the EasyMesh / UniFi scaffolds
  // are registered only when their flag is on. Both default off, so the
  // single-box config runs exactly one source — the multiplexer then
  // behaves byte-for-byte as the Phase-1 single-source path.
  const sources: DiscoverySource[] = [new MdnsDiscoverySource(openwrt)];
  if (flags.easymeshEnabled) {
    sources.push(new EasyMeshDiscoverySource({ enabled: true }));
  }
  if (flags.unifiEnabled) {
    // ADR-024 Phase 3: the UniFi source reads the customer-supplied
    // controller's pending-adoption list through the official local API
    // client (built from DROPLET_AP_UNIFI_CONTROLLER_URL + API key). Option B
    // — we never bundle the controller; the box just points at the one the
    // household already runs.
    sources.push(
      new UniFiDiscoverySource({ enabled: true }, createUniFiNetworkClient()),
    );
  }
  const multiplexer = createDiscoveryMultiplexer(prisma, sources);

  return {
    async pollOnce() {
      try {
        await multiplexer.discoverAndReconcile();
      } catch (err) {
        // Routing service down, schema drift, etc. — degrade to a logged
        // no-op so the cron-runtime doesn't go into its consecutive-
        // failures backoff for a transient routing outage. Next tick
        // retries. Cold-start-aware: an UNREACHABLE during the boot grace
        // window logs at debug instead of flooding warn on every fresh boot.
        logRouterError(logger, err, "ap-discovery: pollOnce failed");
      }
    },
  };
}

/**
 * Register the AP discovery poller with the orchestrator's cron runtime.
 * `index.ts` calls this once during boot, passing the shared
 * `cronRuntime` (so the same Postgres advisory-lock infrastructure used
 * by the schedule ticker and device reconciler covers this tick too).
 *
 * The pg-advisory lock key matches the convention used by
 * `device-reconcile-poller` / `schedule-ticker`: `droplet:<job-name>`.
 * Multi-instance deploys (warm standby) only run the discovery handler
 * on the replica that wins the lock; other replicas skip silently.
 */
export function startApDiscoveryPoller(
  cronRuntime: CronRuntime,
  prisma: PrismaClient,
  openwrt: ApDiscoveryOpenwrtClient,
  intervalMs: number,
  flags: ApDiscoveryBackendFlags = {},
): ApDiscoveryPoller {
  const poller = createApDiscoveryPoller(prisma, openwrt, flags);
  cronRuntime.scheduleInterval(
    intervalMs,
    () => poller.pollOnce(),
    { lockKey: "droplet:ap-discovery-poller" },
  );
  logger.info(
    {
      intervalMs,
      easymeshEnabled: flags.easymeshEnabled ?? false,
      unifiEnabled: flags.unifiEnabled ?? false,
    },
    "ap-discovery poller started",
  );
  return poller;
}
