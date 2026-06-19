/**
 * ADR-024 Phase 2 — AP discovery multiplexer + pluggable discovery sources.
 *
 * Phase 1 wired a single mDNS discovery path (ap-discovery-poller.ts →
 * openwrt.listDiscoveredAps() → reconcileDiscovered()) that always
 * created DROPLET_IMAGE rows. Phase 2 makes discovery pluggable so a
 * household can later bring a third-party coverage AP (EasyMesh / UniFi)
 * through the SAME "plug in → auto-discover → LLM adds it" experience.
 *
 * Shape (ADR-024 §1 + Architecture diagram):
 *
 *   ┌─ MdnsDiscoverySource      ─┐
 *   ├─ EasyMeshDiscoverySource  ─┤  fan out (enabled only)
 *   └─ UniFiDiscoverySource     ─┘
 *               │  merge snapshots (each obs carries an EXPLICIT `backend`)
 *               ▼
 *      reconcileDiscovered(prisma, merged)  ── one reconcile pass; the
 *               │                              create path stamps the
 *               ▼                              row's backend from obs.backend
 *      ApDevice rows (AWAITING_APPROVAL, backend-tagged)
 *
 * Discipline:
 *   - No new scheduler. The multiplexer is driven by the existing
 *     ap-discovery-poller's `cron-runtime.service.ts` scheduleInterval +
 *     pg-advisory-lock tick (ADR-024 §6 — no `while True`).
 *   - The `backend` is an EXPLICIT field on every observation, never
 *     inferred from absence (CLAUDE.md no-guessing rule).
 *   - EasyMesh / UniFi sources are gated behind `DROPLET_AP_*` env flags
 *     (never `MATTER_*`), both default off (ADR-024 §5). This phase they
 *     are SCAFFOLDS: when off (always, this phase) they return []. The
 *     real socket logic (IEEE 1905.1 / UDP 10001) lands in Phases 4 / 3.
 *
 * With both flags off, only the mDNS source runs and only DROPLET_IMAGE
 * rows are created — the shipping single-box path is byte-for-byte the
 * same as Phase 1.
 */

import pino from "pino";
import type { PrismaClient } from "@prisma/client";
import {
  reconcileDiscovered,
  type DiscoveredApObservation,
} from "./ap-onboard.service.js";
import {
  UniFiClientError,
  type UniFiNetworkClient,
} from "./unifi-network.client.js";

const logger = pino({ name: "ap-discovery-multiplexer" });

/**
 * One discovery source = one backend's current snapshot of the LAN.
 * `discover()` returns the observations this source can see RIGHT NOW,
 * each tagged with its `backend` (ADR-024 §1). The multiplexer owns the
 * fan-out + reconcile; a source owns only its protocol.
 *
 * Mirrors the ADR-024 §1 `discover(): Promise<DiscoveredApObservation[]>`
 * interface. A source MAY throw (the live mDNS source surfaces a
 * RouterError when the routing hop is down); the poller's existing
 * cold-start-aware catch (`logRouterError`) handles it and the next tick
 * recovers — the Phase-1 belt-and-suspenders contract, preserved.
 */
export interface DiscoverySource {
  discover(): Promise<DiscoveredApObservation[]>;
}

/**
 * Narrow surface of the openwrt client the mDNS source needs. Mirrors the
 * `/aps/discovered` payload (snake_case + optional fields). Identical to
 * the Phase-1 `ApDiscoveryOpenwrtClient` so the wiring in index.ts/poller
 * passes the same `openwrt.client` module namespace unchanged.
 */
export interface MdnsOpenwrtClient {
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
 * LIVE source (ADR-005 / ADR-024 DROPLET_IMAGE backend). Wraps the
 * existing `openwrt.listDiscoveredAps()` path — the parsed `umdns browse`
 * output filtered to `_droplet-ap._tcp` records — and tags every
 * observation DROPLET_IMAGE. This reproduces the Phase-1 mDNS behavior
 * exactly; the ONLY change is that the tag is now explicit on the
 * observation instead of hardcoded in the reconciler.
 */
export class MdnsDiscoverySource implements DiscoverySource {
  constructor(private readonly openwrt: MdnsOpenwrtClient) {}

  async discover(): Promise<DiscoveredApObservation[]> {
    const discovered = await this.openwrt.listDiscoveredAps();
    return discovered.map((d) => ({
      mac: d.mac,
      // Explicit backend tag — the Droplet OpenWrt extender image. The
      // reconciler stamps the row's `backend` column from this.
      backend: "DROPLET_IMAGE" as const,
      model: d.model,
      serial: d.serial,
      version: d.version,
      lastIp: d.last_ip,
      hostname: d.hostname,
    }));
  }
}

export interface ScaffoldSourceOptions {
  /** Master switch for this backend (ADR-024 §5). Default off. */
  enabled: boolean;
}

/**
 * SCAFFOLD (ADR-024 §2, Phase 4) — EasyMesh / IEEE 1905.1 discovery.
 *
 * Gated behind `DROPLET_AP_EASYMESH_ENABLED` (default 0/off). When off —
 * which is ALWAYS this phase — `discover()` returns []. There is NO real
 * socket code here yet: Phase 4 adds the 1905.1 topology bridge that
 * surfaces newly-seen Agent AL-MACs as `backend=EASYMESH` observations,
 * onboarded by a prplMesh controller in Controller-only mode. Registered
 * now so the multiplexer shape is real and the off-path is tested, but it
 * contributes zero behavior until its phase lands.
 */
export class EasyMeshDiscoverySource implements DiscoverySource {
  constructor(private readonly options: ScaffoldSourceOptions) {}

  async discover(): Promise<DiscoveredApObservation[]> {
    if (!this.options.enabled) return [];
    // Phase 4: open the IEEE 1905.1 topology bridge here and map newly
    // seen Agent AL-MACs to { backend: "EASYMESH", ... }. Until then an
    // enabled flag with no implementation still yields nothing rather than
    // pretending — no state from absence.
    logger.debug(
      "easymesh discovery enabled but the 1905.1 bridge is a Phase-4 scaffold; yielding []",
    );
    return [];
  }
}

/**
 * LIVE source (ADR-024 §3, Phase 3) — UniFi discovery via the official local
 * UniFi Network API.
 *
 * Gated behind `DROPLET_AP_UNIFI_ENABLED` (default 0/off). When off — the
 * shipping single-box default — `discover()` returns []. When on, it reads
 * the controller's *Pending Adoption* list (the primary discovery signal: a
 * factory-default UniFi AP gets a lease, broadcasts UBNT discovery, and
 * surfaces as pending on the controller) and maps each device to a
 * `backend: "UNIFI", vendor: "Ubiquiti"` observation, carrying the
 * controller `device_id` as `backendRef` so the approve path can address it.
 *
 * The `UniFiNetworkClient` is the SEAM — injected so this source unit-tests
 * against a mock (there is no controller on the dev laptop; the wire shapes
 * are validated against a real controller later, see unifi-network.client.ts).
 * When enabled but no client is wired (defensive — the poller always passes
 * one when the flag is on), `discover()` yields [] rather than throwing, so a
 * misconfiguration never crashes the discovery tick.
 */
export class UniFiDiscoverySource implements DiscoverySource {
  constructor(
    private readonly options: ScaffoldSourceOptions,
    private readonly client?: UniFiNetworkClient,
  ) {}

  async discover(): Promise<DiscoveredApObservation[]> {
    if (!this.options.enabled) return [];
    if (!this.client) {
      logger.warn(
        "unifi discovery enabled but no controller client wired; yielding []",
      );
      return [];
    }
    let pending;
    try {
      pending = await this.client.listPendingDevices();
    } catch (err) {
      // A household can flip DROPLET_AP_UNIFI_ENABLED on BEFORE entering the
      // controller URL / API key. That must never take down the whole
      // discovery tick (the live mDNS / DROPLET_IMAGE path has to survive a
      // half-configured UniFi backend). NOT_CONFIGURED degrades to [] — the
      // box just hasn't been pointed at a controller yet. Any OTHER error
      // (auth, unreachable controller) propagates so the poller's
      // cold-start-aware catch logs it and the next tick retries — we don't
      // silently swallow a real, configured-but-failing controller.
      if (err instanceof UniFiClientError && err.code === "NOT_CONFIGURED") {
        logger.debug(
          "unifi discovery enabled but controller URL / API key not set; yielding [] until configured",
        );
        return [];
      }
      throw err;
    }
    return pending.map((d) => ({
      mac: d.mac,
      // Explicit backend tag — the reconciler stamps ApDevice.backend from it.
      backend: "UNIFI" as const,
      vendor: "Ubiquiti",
      backendRef: d.deviceId,
      model: d.model,
      lastIp: d.ip,
    }));
  }
}

export interface DiscoveryMultiplexer {
  /**
   * Fan out every registered source, merge their observations, and
   * reconcile the merged snapshot into ApDevice in a single pass. Returns
   * the create/update/evict tallies. A source's failure propagates so the
   * caller (the poller) can route it through its cold-start-aware
   * `logRouterError` catch — the Phase-1 contract for the live mDNS source.
   */
  discoverAndReconcile(): Promise<{
    created: number;
    updated: number;
    evicted: number;
  }>;
}

/**
 * Build the discovery multiplexer over a set of sources. Only the sources
 * passed in run — the wiring (poller / index.ts) decides which to include
 * based on the `DROPLET_AP_*_ENABLED` flags, so a single-box with no
 * extenders registers only the mDNS source.
 */
export function createDiscoveryMultiplexer(
  prisma: PrismaClient,
  sources: DiscoverySource[],
): DiscoveryMultiplexer {
  return {
    async discoverAndReconcile() {
      // Fan out concurrently and merge. A source's rejection propagates to
      // the caller (the poller wraps this in its cold-start-aware
      // `logRouterError` catch — the Phase-1 contract for the live mDNS
      // source). The scaffold sources never throw (they return [] when
      // off, always this phase), so today the only source that can reject
      // is mDNS, and it must surface exactly as it did pre-multiplexer.
      const snapshots = await Promise.all(sources.map((s) => s.discover()));
      const merged: DiscoveredApObservation[] = snapshots.flat();

      if (merged.length === 0) {
        return { created: 0, updated: 0, evicted: 0 };
      }

      // One reconcile pass over the merged snapshot. The reconciler stamps
      // each row's `backend` from the observation's explicit tag, and the
      // LRU eviction it runs counts the actionable surface across ALL
      // backends (the cap is a per-box budget, not per-backend).
      const tally = await reconcileDiscovered(prisma, merged);
      if (tally.created > 0 || tally.updated > 0) {
        logger.info(
          {
            created: tally.created,
            updated: tally.updated,
            evicted: tally.evicted,
            observedCount: merged.length,
            sources: sources.length,
          },
          "ap-discovery: multiplexer reconciled",
        );
      }
      return tally;
    },
  };
}
