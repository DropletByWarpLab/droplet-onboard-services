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

import type { PrismaClient } from "@prisma/client";
import { logRouterError } from "./openwrt.client.js";
import {
  reconcileDiscovered,
  type DiscoveredApObservation,
} from "./ap-onboard.service.js";
import {
  UniFiClientError,
  type UniFiNetworkClient,
} from "./unifi-network.client.js";
import {
  EasyMeshControllerError,
  type EasyMeshControllerClient,
} from "./easymesh-controller.client.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("ap-discovery-multiplexer");

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
 * LIVE source (ADR-024 §2, Phase 4) — EasyMesh discovery via the local
 * prplMesh controller's 1905.1 topology.
 *
 * Gated behind `DROPLET_AP_EASYMESH_ENABLED` (default 0/off). When off — the
 * shipping single-box default — `discover()` returns []. When on, it reads the
 * controller's onboarding-Agents list (the 1905.1 topology: certified
 * third-party APs currently visible / onboarding on the box's fronthaul BSS)
 * and maps each Agent to a `backend: "EASYMESH"` observation, carrying the
 * Agent's AL-MAC as both `mac` and `backendRef` so the approve path can address
 * it. `vendor` comes from the Agent's 1905.1 device info WHEN PRESENT (else
 * undefined — never guessed, CLAUDE.md no-guessing rule).
 *
 * The `EasyMeshControllerClient` is the SEAM — injected so this source
 * unit-tests against a mock (there is no controller on the dev laptop, and
 * prplMesh-on-mt76 is the ADR's open hardware risk; the ubus shapes are
 * validated on the lab box later — see easymesh-controller.client.ts). When
 * enabled but no client is wired (defensive — the poller always passes one when
 * the flag is on), `discover()` yields [] rather than throwing, so a
 * misconfiguration never crashes the discovery tick.
 *
 * The box runs prplMesh in CONTROLLER-ONLY mode: its mt76 radio is NOT an
 * EasyMesh RF agent (ADR-024 §2). This source only reads the control plane.
 */
export class EasyMeshDiscoverySource implements DiscoverySource {
  constructor(
    private readonly options: ScaffoldSourceOptions,
    private readonly client?: EasyMeshControllerClient,
  ) {}

  async discover(): Promise<DiscoveredApObservation[]> {
    if (!this.options.enabled) return [];
    if (!this.client) {
      logger.warn(
        "easymesh discovery enabled but no controller client wired; yielding []",
      );
      return [];
    }
    let agents;
    try {
      agents = await this.client.listOnboardingAgents();
    } catch (err) {
      // A household can flip DROPLET_AP_EASYMESH_ENABLED on BEFORE the prplMesh
      // controller URL is set. That must never take down the whole discovery
      // tick — the same safety pattern the Phase-3 UniFi source uses, so the
      // live mDNS / DROPLET_IMAGE path survives a half-configured EasyMesh
      // backend. NOT_CONFIGURED degrades to []; any OTHER error (auth,
      // unreachable controller) propagates so the poller's cold-start-aware
      // catch logs it and the next tick retries — we don't silently swallow a
      // real, configured-but-failing controller.
      if (
        err instanceof EasyMeshControllerError &&
        err.code === "NOT_CONFIGURED"
      ) {
        logger.debug(
          "easymesh discovery enabled but controller URL not set; yielding [] until configured",
        );
        return [];
      }
      throw err;
    }
    return agents.map((a) => ({
      mac: a.alMac,
      // Explicit backend tag — the reconciler stamps ApDevice.backend from it.
      backend: "EASYMESH" as const,
      // 1905.1 AL-MAC is the backend-scoped opaque id the approve path uses.
      backendRef: a.alMac,
      // Vendor from the Agent's 1905.1 device info when present; else undefined.
      vendor: a.vendor,
      model: a.model,
    }));
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
      // Fan out concurrently, then merge only fulfilled sources. Using
      // Promise.allSettled prevents a single failing backend (e.g. EasyMesh
      // controller UNREACHABLE) from discarding mDNS results that already
      // resolved, which would stall lastSeen updates for extenders that tick.
      const results = await Promise.allSettled(sources.map((s) => s.discover()));
      const merged: DiscoveredApObservation[] = [];
      for (const result of results) {
        if (result.status === "fulfilled") {
          merged.push(...result.value);
        } else {
          // Route through the cold-start-aware helper: on every boot the
          // routing service isn't up yet, so the live mDNS source throws
          // UNREACHABLE — logRouterError downgrades that to debug rather than
          // warn-spamming the log on each tick, while still warning on genuine
          // (non-cold-start) source failures.
          logRouterError(
            logger,
            result.reason,
            "ap-discovery: source failed, omitting its snapshot",
          );
        }
      }

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
