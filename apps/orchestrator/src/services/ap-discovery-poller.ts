/**
 * WARP-446 — AP discovery poller (blocker #1 fix-up).
 *
 * Wires the orchestrator-side mDNS discovery loop required by ADR-005
 * §1. On every tick the poller queries the routing service's
 * `/aps/discovered` endpoint (which on a real router returns the parsed
 * `umdns browse` output filtered to `_droplet-ap._tcp` records, and on
 * the mock router returns the in-memory seed list driven by tests +
 * dev). The observed snapshot is fed into `reconcileDiscovered()` which
 * owns the state-machine transitions — brand-new MACs land in
 * AWAITING_APPROVAL; existing rows just bump `lastSeen` + any new mDNS
 * fields.
 *
 * Same shape as `device-reconcile-poller.ts`: narrow `OpenwrtClient`
 * surface so tests can inject in-memory mocks without pulling the whole
 * module. Failures degrade to a logged no-op — missing one 10s window
 * of discovery is fine, the next tick recovers.
 *
 * Wired in `index.ts` via `createCronRuntime(...).scheduleInterval(...)`
 * at the `DROPLET_AP_DISCOVERY_INTERVAL`-second cadence so AC #1
 * ("AWAITING_APPROVAL within 30 s of plug-in") is met by default (10 s
 * cadence × 3-tick budget).
 */
import pino from "pino";
import type { PrismaClient } from "@prisma/client";
import { reconcileDiscovered } from "./ap-onboard.service.js";
import { logRouterError } from "./openwrt.client.js";
import type { CronRuntime } from "./cron-runtime.service.js";

const logger = pino({ name: "ap-discovery-poller" });

/**
 * Narrow surface of the openwrt client the poller needs. Mirrors the
 * `DiscoveredApInfo` shape coming off `/aps/discovered`. Kept loose
 * (snake_case keys + optional fields) so the mapping to
 * `DiscoveredApObservation` happens at this boundary, not at the
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
): ApDiscoveryPoller {
  return {
    async pollOnce() {
      try {
        const discovered = await openwrt.listDiscoveredAps();
        if (discovered.length === 0) {
          // Nothing announcing this tick — common steady-state on a
          // single-extender household once the unit has been approved
          // (the routing layer drops ONLINE rows out of the discovery
          // list; only AWAITING_APPROVAL surface here).
          return;
        }
        const observed = discovered.map((d) => ({
          mac: d.mac,
          model: d.model,
          serial: d.serial,
          version: d.version,
          lastIp: d.last_ip,
          hostname: d.hostname,
        }));
        const { created, updated } = await reconcileDiscovered(prisma, observed);
        if (created > 0 || updated > 0) {
          logger.info(
            { created, updated, observedCount: observed.length },
            "ap-discovery: reconciled",
          );
        }
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
): ApDiscoveryPoller {
  const poller = createApDiscoveryPoller(prisma, openwrt);
  cronRuntime.scheduleInterval(
    intervalMs,
    () => poller.pollOnce(),
    { lockKey: "droplet:ap-discovery-poller" },
  );
  logger.info({ intervalMs }, "ap-discovery poller started");
  return poller;
}
