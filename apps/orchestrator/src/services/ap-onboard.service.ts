/**
 * AP onboarding service — discovery + state-machine transitions for the
 * coverage-extender flow.
 *
 * ADR-024 (Phase 1) generalises this from a single-vendor (Droplet
 * OpenWrt image, ADR-005) pipeline into backend-pluggable dispatch.
 * `ApDevice.backend` is the explicit discriminator (CLAUDE.md
 * no-guessing rule — never derived from absence) for which backend owns
 * a row's discovery + provisioning. The public service functions become
 * thin routers that select a handler by that column, defaulting to
 * `DROPLET_IMAGE` (the only backend that does anything today).
 *
 * Layers:
 *   1. `reconcileDiscovered(prisma, observed)` — upserts a fresh mDNS
 *      snapshot into ApDevice. Brand-new MACs land in AWAITING_APPROVAL
 *      (DISCOVERED is reserved for the per-tick interim state — the
 *      poller will collapse it to AWAITING_APPROVAL the same tick).
 *      Existing rows just bump `lastSeen` + any new model/version info.
 *      All rows created here carry `backend = DROPLET_IMAGE`.
 *   2. `approveAp(prisma, mac, opts, actor)` — transitions
 *      AWAITING_APPROVAL → PROVISIONING → ONLINE (or FAILED). Pushes
 *      the wireless config through `openwrt.client.approveAp` and
 *      writes the audit columns (`approvedAt`, `approvedBy`,
 *      `approvedSsid`, `lastOperationId`).
 *   3. `decommissionAp(prisma, mac)` — transitions ONLINE →
 *      DECOMMISSIONED. Idempotent on already-DECOMMISSIONED rows.
 *
 * The service owns the state machine; the route layer is a thin
 * dispatch + RBAC veneer. Within the service, the ADR-005 behavior lives
 * verbatim inside `DropletImageBackend`; the exported functions route to
 * it. EASYMESH / UNIFI handlers are registry stubs (later ADR-024
 * phases) — present so the dispatch shape is real, but they add no
 * behavior this phase.
 */

import type { PrismaClient } from "@prisma/client";
import { normalizeMac } from "../lib/mac.js";
import {
  approveAp as routingApproveAp,
  decommissionAp as routingDecommissionAp,
  getApBandSteering as routingGetApBandSteering,
  setApBandSteering as routingSetApBandSteering,
  getApWireless as routingGetApWireless,
  setApWireless as routingSetApWireless,
  RouterError,
  type ApWireless,
} from "./openwrt.client.js";
import {
  createUniFiNetworkClient,
  type UniFiNetworkClient,
} from "./unifi-network.client.js";
import {
  createEasyMeshControllerClient,
  type EasyMeshControllerClient,
} from "./easymesh-controller.client.js";
// WARP-1761 — WRITE-path only. `getApWifi` below deliberately does NOT import
// anything from here: ADR-035 §1 keeps reads dialing the device.
import { recordWifiPrimaryIntent } from "./network-intent.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("ap-onboard");

/**
 * Canonical backend keys — mirror the `ApOnboardBackend` Prisma enum
 * (ADR-024 §1). Kept as a string union (not an import of the generated
 * enum) so this module stays usable in the unit-test setup where
 * `@prisma/client` is mocked.
 */
export type ApOnboardBackendKey = "DROPLET_IMAGE" | "EASYMESH" | "UNIFI";

/**
 * Per ADR-005 §"Consequences": the discovered-list is capped to
 * 25 entries (LRU) as the mDNS-spoof DoS mitigation. A malicious LAN
 * device CAN spoof `_droplet-ap._tcp` announces; capping bounds the
 * worst-case dashboard noise. Eligible-for-eviction = the set of rows
 * the operator hasn't acted on yet (DISCOVERED + AWAITING_APPROVAL);
 * approved / online / failed / decommissioned rows are persistent and
 * never evicted by this mechanism.
 *
 * The cap is also surfaced via `GET /api/aps/discovered` so the
 * dashboard can show the operator when the list saturates.
 */
export const DISCOVERED_AP_LRU_CAP = 25;

/**
 * Typed error codes for AP-onboard failures. Surfaces in
 * `ApOnboardError.code` and the JSON error body so the dashboard's
 * `AP_ONBOARD_ERROR_COPY` table can key on it instead of regex-matching
 * the raw `failureReason` string (blocker #7).
 *
 * - `AP_NOT_FOUND`            — orchestrator never saw this MAC announce.
 * - `AP_INVALID`              — schema / boundary validation failure.
 * - `PROVISIONING_TIMEOUT`    — the routing-service safe_apply timed out.
 * - `ROUTER_UNREACHABLE`      — the routing service itself is down /
 *                               the main OpenWrt box won't accept the
 *                               ubus session.
 * - `WIRELESS_CONFIG_REJECTED`— OpenWrt accepted the call but rejected
 *                               the uci change (e.g. invalid PSK shape
 *                               on the router side).
 * - `UNKNOWN`                 — anything that escaped classification.
 */
export type ApOnboardErrorCode =
  | "AP_NOT_FOUND"
  | "AP_INVALID"
  | "PROVISIONING_TIMEOUT"
  | "ROUTER_UNREACHABLE"
  | "WIRELESS_CONFIG_REJECTED"
  // WARP-1703: band steering can't be toggled on this shape — no ONLINE
  // Droplet-image AP, no AP credential, or the AP's image predates the
  // droplet.wifi substrate. Mirrors the routing service's 422 code verbatim.
  | "AP_BAND_STEERING_UNAVAILABLE"
  // WARP-1712: the AP's network name can't be read/changed on this shape —
  // no ONLINE Droplet-image AP, no AP credential, or the AP reports no
  // wireless interfaces. Mirrors the routing service's 422 code verbatim.
  | "AP_WIRELESS_UNAVAILABLE"
  | "UNKNOWN";

export class ApOnboardError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: ApOnboardErrorCode,
  ) {
    super(message);
    this.name = "ApOnboardError";
  }

  static notFound(mac: string): ApOnboardError {
    return new ApOnboardError(`AP ${mac} not found`, 404, "AP_NOT_FOUND");
  }

  static invalid(message: string): ApOnboardError {
    return new ApOnboardError(message, 400, "AP_INVALID");
  }

  /**
   * Translate a RouterError into the AP-onboard taxonomy. Keeps the
   * dashboard's `AP_ONBOARD_ERROR_COPY` table the single source of
   * truth for user-facing copy.
   */
  static routerError(err: RouterError): ApOnboardError {
    // RouterError statuses already encode the right HTTP semantics
    // (502 = bad-gateway-ish for routing-service failures, 503 for
    // disabled, 504 for timeout); for unknown codes we default to 502
    // since the routing service is the gateway. status is optional on
    // RouterError (network-error path doesn't set one).
    const status = err.status && err.status >= 400 ? err.status : 502;
    let code: ApOnboardErrorCode;
    switch (err.code) {
      case "TIMEOUT":
        code = "PROVISIONING_TIMEOUT";
        break;
      case "UNREACHABLE":
      case "AUTH":
      case "DISABLED":
        code = "ROUTER_UNREACHABLE";
        break;
      case "ROLLED_BACK":
        // The router refused to apply the wireless change (safe_apply
        // rolled back) — surface that as a config-rejection.
        code = "WIRELESS_CONFIG_REJECTED";
        break;
      default:
        code = "UNKNOWN";
    }
    return new ApOnboardError(err.message, status, code);
  }
}

/**
 * Public shape returned by `approveAp` + `decommissionAp` so route
 * handlers can echo both the updated row AND the routing-service
 * operation_id (the dashboard's optimistic-update flow polls
 * `/api/network/operations/:id` against this value). `operationId` is
 * null when the underlying routing call didn't surface one (older
 * routing build, idempotent short-circuit, GET fallback).
 */
export interface ApMutationResult {
  ap: unknown;
  operationId: string | null;
}

export interface DiscoveredApObservation {
  mac: string;
  /**
   * ADR-024 Phase 2: the discovery source that produced this observation,
   * carried as an EXPLICIT tag so the reconciler can stamp the row's
   * `backend` column from it (never inferred — CLAUDE.md no-guessing
   * rule). Optional for back-compat: the live mDNS source sets it to
   * `DROPLET_IMAGE`, and an observation that omits it (a legacy caller)
   * defaults to `DROPLET_IMAGE` on create — the only live backend today
   * and the schema default.
   */
  backend?: ApOnboardBackendKey;
  /**
   * ADR-024 Phase 3: backend-scoped opaque id surfaced by discovery (the
   * UniFi controller `device_id`, a 1905.1 AL-MAC, etc.). Persisted to
   * `ApDevice.backendRef` on create so the approve path can address the
   * device on the backend without re-deriving it. Optional — the
   * DROPLET_IMAGE / mDNS source has no such id and omits it.
   */
  backendRef?: string;
  model?: string;
  serial?: string;
  version?: string;
  lastIp?: string;
  hostname?: string;
  /** Human vendor label surfaced in the dashboard/LLM ("TP-Link"). */
  vendor?: string;
}

/**
 * Upsert each observation. The reconciler is called by the discovery
 * poller on every tick; the same MAC re-appearing is the common case.
 *
 * State transitions:
 *   - MAC not in DB         → create with status=AWAITING_APPROVAL.
 *                             (Skipping the DISCOVERED interim state
 *                              because the poller doesn't have a
 *                              follow-up tick to flip it; ADR-005's
 *                              state machine keeps DISCOVERED as a
 *                              schema slot for future surfaces.)
 *   - MAC in AWAITING_APPROVAL → touch lastSeen + merge new mDNS
 *                                fields. Status unchanged.
 *   - MAC in ONLINE         → touch lastSeen only. The dashboard
 *                             may surface a "stale extender" warning
 *                             when lastSeen drifts behind now() by
 *                             multiple discovery intervals.
 *   - MAC in DECOMMISSIONED → touch lastSeen only. Operator must
 *                             explicitly re-approve to bring it back
 *                             — re-discovery shouldn't auto-resurrect.
 *   - MAC in PROVISIONING / FAILED → touch lastSeen only. Failed APs
 *                             stay failed until re-approved.
 */
async function dropletImageReconcile(
  prisma: PrismaClient,
  observed: DiscoveredApObservation[],
): Promise<{ created: number; updated: number; evicted: number }> {
  let created = 0;
  let updated = 0;
  for (const obs of observed) {
    const mac = normalizeMac(obs.mac);
    const existing = await prisma.apDevice.findUnique({ where: { mac } });
    if (existing) {
      await prisma.apDevice.update({
        where: { mac },
        data: {
          lastSeen: new Date(),
          // Merge any new mDNS-reported fields, but don't overwrite
          // operator-set displayName.
          model: obs.model ?? existing.model,
          serial: obs.serial ?? existing.serial,
          version: obs.version ?? existing.version,
          lastIp: obs.lastIp ?? existing.lastIp,
          hostname: obs.hostname ?? existing.hostname,
        },
      });
      updated += 1;
      continue;
    }
    await prisma.apDevice.upsert({
      where: { mac },
      create: {
        mac,
        status: "AWAITING_APPROVAL",
        // ADR-024 Phase 2: stamp the row's backend from the observation's
        // EXPLICIT `backend` tag (set by the discovery source that found
        // it), never derived from anything (CLAUDE.md no-guessing rule).
        // A tag-less observation (legacy caller) defaults to DROPLET_IMAGE
        // — the only live backend today and the schema default — so the
        // Phase-1 mDNS path is byte-for-byte unchanged.
        backend: obs.backend ?? "DROPLET_IMAGE",
        // Backend-scoped opaque id (UniFi device_id, …), explicit on the
        // observation. Null when the source has none (mDNS / DROPLET_IMAGE).
        backendRef: obs.backendRef,
        vendor: obs.vendor,
        model: obs.model,
        serial: obs.serial,
        version: obs.version,
        lastIp: obs.lastIp,
        hostname: obs.hostname,
      },
      update: {
        lastSeen: new Date(),
      },
    });
    created += 1;
  }
  const evicted = await evictDiscoveredAps(prisma);
  return { created, updated, evicted };
}

/**
 * Enforce the LRU cap on the discovered-list per ADR-005. Counts rows
 * in `AWAITING_APPROVAL` + `DISCOVERED` and deletes the oldest-`lastSeen`
 * entries until the count is ≤ `DISCOVERED_AP_LRU_CAP`. Returns the
 * number of rows removed.
 *
 * Approved / online / failed / decommissioned rows are excluded by
 * design — the cap is about bounding the operator-actionable surface
 * area, not about purging the audit trail.
 */
export async function evictDiscoveredAps(
  prisma: PrismaClient,
): Promise<number> {
  const eligibleCount = await prisma.apDevice.count({
    where: { status: { in: ["AWAITING_APPROVAL", "DISCOVERED"] } },
  });
  if (eligibleCount <= DISCOVERED_AP_LRU_CAP) return 0;
  const overflow = eligibleCount - DISCOVERED_AP_LRU_CAP;
  const stale = await prisma.apDevice.findMany({
    where: { status: { in: ["AWAITING_APPROVAL", "DISCOVERED"] } },
    orderBy: { lastSeen: "asc" },
    take: overflow,
    select: { mac: true },
  });
  if (stale.length === 0) return 0;
  const result = await prisma.apDevice.deleteMany({
    where: { mac: { in: stale.map((row) => row.mac) } },
  });
  if (result.count > 0) {
    logger.warn(
      { evicted: result.count, cap: DISCOVERED_AP_LRU_CAP },
      "ap-onboard: discovered-list LRU cap reached, evicting oldest entries",
    );
  }
  return result.count;
}

export interface ApproveOptions {
  ssid: string;
  encryptionKey: string;
  radio?: string;
  encryption?: string;
  network?: string;
  displayName?: string;
}

/**
 * Approve a discovered AP and push the wireless config.
 *
 * Three-step state walk:
 *   1. Mark row PROVISIONING. Surfaces "spinning" in the dashboard.
 *   2. Call routing service. On success the row goes ONLINE; on
 *      failure the row goes FAILED with `failureReason` populated.
 *   3. On success, audit columns (`approvedAt`, `approvedBy`,
 *      `approvedSsid`, `lastOperationId`) are written.
 *
 * Returns `{ ap, operationId }` so the route layer can echo BOTH back
 * to the dashboard (which polls `/api/network/operations/:id` against
 * the operationId). `operationId` is null when the routing layer
 * didn't surface one (older builds, GET fallback).
 */
async function dropletImageApprove(
  prisma: PrismaClient,
  rawMac: string,
  opts: ApproveOptions,
  actor: { username: string },
): Promise<ApMutationResult> {
  const mac = normalizeMac(rawMac);

  const existing = await prisma.apDevice.findUnique({ where: { mac } });
  if (!existing) {
    throw ApOnboardError.notFound(mac);
  }

  // Mark as provisioning before the network call so the dashboard's
  // polling read sees "spinning" rather than the stale state.
  await prisma.apDevice.update({
    where: { mac },
    data: {
      status: "PROVISIONING",
      failureReason: null,
    },
  });

  try {
    const result = await routingApproveAp({
      mac,
      ssid: opts.ssid,
      encryptionKey: opts.encryptionKey,
      radio: opts.radio,
      encryption: opts.encryption,
      network: opts.network,
    });
    const operationId = result.operation_id ?? null;
    const updated = await prisma.apDevice.update({
      where: { mac },
      data: {
        status: "ONLINE",
        approvedAt: new Date(),
        approvedBy: actor.username,
        approvedSsid: opts.ssid,
        lastOperationId: operationId,
        displayName: opts.displayName ?? existing.displayName ?? defaultDisplayName(mac, existing.model ?? null),
        failureReason: null,
      },
    });
    return { ap: updated, operationId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, mac, ssid: opts.ssid },
      "ap-onboard: approve failed; transitioning to FAILED",
    );
    await prisma.apDevice.update({
      where: { mac },
      data: {
        status: "FAILED",
        failureReason: message,
      },
    });
    if (err instanceof RouterError) {
      throw ApOnboardError.routerError(err);
    }
    // Generic error from the openwrt.client mock or elsewhere — bubble
    // a 502 because the routing-service hop is the gateway.
    throw new ApOnboardError(message, 502, "UNKNOWN");
  }
}

/**
 * Decommission an AP. Idempotent on already-DECOMMISSIONED rows (the
 * common operator-double-click case).
 *
 * Returns `{ ap, operationId }`. `operationId` is null for the
 * already-DECOMMISSIONED short-circuit (no in-flight routing call to
 * poll) and when the routing layer didn't surface one.
 */
async function dropletImageDecommission(
  prisma: PrismaClient,
  rawMac: string,
): Promise<ApMutationResult> {
  const mac = normalizeMac(rawMac);

  const existing = await prisma.apDevice.findUnique({ where: { mac } });
  if (!existing) {
    throw ApOnboardError.notFound(mac);
  }
  if (existing.status === "DECOMMISSIONED") {
    // Idempotent — the operator already pulled the trigger. Return
    // the row unchanged rather than re-firing the routing call.
    return { ap: existing, operationId: null };
  }

  try {
    const result = await routingDecommissionAp({ mac });
    const operationId = result.operation_id ?? null;
    const updated = await prisma.apDevice.update({
      where: { mac },
      data: {
        status: "DECOMMISSIONED",
        decommissionedAt: new Date(),
        lastOperationId: operationId,
        failureReason: null,
      },
    });
    return { ap: updated, operationId };
  } catch (err) {
    if (err instanceof RouterError) {
      throw ApOnboardError.routerError(err);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ApOnboardError(message, 502, "UNKNOWN");
  }
}

function defaultDisplayName(mac: string, model: string | null): string {
  // "AP (12:34:56)" — model + the last 3 octets so the operator
  // can tell two extenders apart in the dashboard before they pick a
  // displayName of their own. The device-tree compatible string
  // `raspberrypi,5-model-b` is the literal value Pi-based APs emit on
  // /proc/device-tree/compatible — matched here for detection (do NOT
  // rename it), but the operator-facing label stays hardware-agnostic
  // (ADR-011).
  const last3 = mac.split(":").slice(-3).join(":");
  if (model && model.includes("raspberrypi,5")) return `AP (${last3})`;
  if (model) return `${model} AP (${last3})`;
  return `Extender (${last3})`;
}

// ─────────────────────────────────────────────────────────────────────
// ADR-024 §1 — backend-pluggable dispatch
//
// One canonical entity (ApDevice), one state machine, one LLM/dashboard
// surface — fanning out to a per-backend handler selected by the row's
// `backend` column. Phase 1 wires the registry shape and moves the
// ADR-005 logic verbatim behind `DropletImageBackend`; EASYMESH / UNIFI
// are NotImplemented stubs so the dispatch shape is real but no behavior
// is added until their phases (4 / 3 respectively).
// ─────────────────────────────────────────────────────────────────────

/**
 * Per-backend onboarding handler. `reconcile` upserts one source's
 * current discovery snapshot; `approve` / `decommission` drive that
 * backend's provisioning. Mirrors the ADR-024 §1 interface (`discover`
 * is realised here as `reconcile`, which both takes the observed
 * snapshot AND writes it — the orchestrator owns the persistence, the
 * backend owns the protocol).
 */
export interface ApOnboardBackendHandler {
  /** Backend key — matches the row's `backend` column + the Prisma enum. */
  readonly key: ApOnboardBackendKey;
  /**
   * Reconcile a fresh discovery snapshot for THIS backend into ApDevice.
   * Returns the create/update/evict tallies the poller surfaces.
   */
  reconcile(
    prisma: PrismaClient,
    observed: DiscoveredApObservation[],
  ): Promise<{ created: number; updated: number; evicted: number }>;
  /** Approve a discovered AP and push its wireless config. */
  approve(
    prisma: PrismaClient,
    rawMac: string,
    opts: ApproveOptions,
    actor: { username: string },
  ): Promise<ApMutationResult>;
  /** Decommission an AP. Idempotent on already-removed rows. */
  decommission(prisma: PrismaClient, rawMac: string): Promise<ApMutationResult>;
}

/**
 * Surfaces as a 501 if a caller ever routes to a backend whose phase hasn't
 * landed — an honest "not built yet" rather than a silent mis-dispatch. As of
 * Phase 4 all three ADR-024 backends (DROPLET_IMAGE, UNIFI, EASYMESH) are real
 * handlers, so nothing throws this today; it is kept as the dispatch-safety
 * taxonomy for any future backend added to `ApOnboardBackend` before its
 * handler is wired.
 */
export class ApBackendNotImplementedError extends ApOnboardError {
  constructor(backend: ApOnboardBackendKey, operation: string) {
    super(
      `AP backend ${backend} is not implemented yet (operation: ${operation})`,
      501,
      "UNKNOWN",
    );
    this.name = "ApBackendNotImplementedError";
  }
}

/**
 * ADR-005 backend — the Droplet OpenWrt extender image. Holds the
 * existing mDNS + uci behavior verbatim by delegating to the module
 * functions above; Phase 1 adds no behavior delta here.
 */
export const DROPLET_IMAGE_BACKEND: ApOnboardBackendHandler = {
  key: "DROPLET_IMAGE",
  reconcile: dropletImageReconcile,
  approve: dropletImageApprove,
  decommission: dropletImageDecommission,
};

// ─────────────────────────────────────────────────────────────────────────
// EASYMESH backend (ADR-024 §2, Phase 4) — prplMesh Controller-only M1/M2.
//
// The box runs prplMesh in CONTROLLER-ONLY mode: its mt76 radio is NOT an
// EasyMesh RF agent (the spike found prplMesh's HAL targets Intel/Qualcomm,
// not mt76); the certified third-party AP is the Agent. The box owns only the
// 1905.1 control plane + the M1/M2 credential push. The handler drives an
// `EasyMeshControllerClient` and mirrors the DROPLET_IMAGE / UNIFI handler's
// transition + audit discipline EXACTLY:
//   - reconcile    : upsert the discovery snapshot (delegates to the shared
//                    dropletImageReconcile — the create path stamps the row's
//                    backend/backendRef/vendor from each EXPLICIT observation
//                    tag, so an EASYMESH observation lands as an EASYMESH row).
//   - approve      : run M1/M2 onboarding (push the household SSID/PSK to the
//                    Agent by AL-MAC); PROVISIONING → ONLINE on success (audit
//                    columns written), PROVISIONING → FAILED + failureReason on
//                    ANY client error (no partial ONLINE).
//   - decommission : remove the Agent on the controller → DECOMMISSIONED;
//                    idempotent on an already-DECOMMISSIONED row.
//
// All state transitions are EXPLICIT `ApDeviceStatus` writes (CLAUDE.md
// no-guessing rule), never derived from absence — identical to ADR-005.
// operationId is null: the controller is request/response (no routing-service
// operation to poll), same as the UNIFI handler.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build an EASYMESH onboarding handler over a given `EasyMeshControllerClient`.
 * The client is the seam — production wires the config-built client, unit tests
 * pass a mock (there is no controller on the dev laptop, and prplMesh-on-mt76
 * is the ADR's open hardware risk).
 */
export function createEasyMeshBackend(
  client: EasyMeshControllerClient,
): ApOnboardBackendHandler {
  return {
    key: "EASYMESH",

    // One state machine: the EASYMESH discovery snapshot is reconciled by the
    // same shared upsert path as every other backend; the create path honors
    // each observation's explicit backend/backendRef/vendor tags.
    reconcile: dropletImageReconcile,

    async approve(
      prisma: PrismaClient,
      rawMac: string,
      opts: ApproveOptions,
      actor: { username: string },
    ): Promise<ApMutationResult> {
      const mac = normalizeMac(rawMac);

      const existing = await prisma.apDevice.findUnique({ where: { mac } });
      if (!existing) {
        throw ApOnboardError.notFound(mac);
      }

      // Mark provisioning BEFORE the controller call so the dashboard's polling
      // read sees "spinning" rather than the stale state — same as the
      // DROPLET_IMAGE / UNIFI paths.
      await prisma.apDevice.update({
        where: { mac },
        data: { status: "PROVISIONING", failureReason: null },
      });

      try {
        // Run M1/M2 onboarding: the controller pushes the household SSID/PSK to
        // the Agent's fronthaul/backhaul BSS, addressed by its 1905.1 AL-MAC
        // (carried as backendRef from discovery; the normalized MAC is the same
        // value for the EASYMESH backend). A throw here leaves the row FAILED
        // (caught below); we never leave a half-onboarded ONLINE.
        await client.onboardAgent(mac, {
          ssid: opts.ssid,
          key: opts.encryptionKey,
        });
        const updated = await prisma.apDevice.update({
          where: { mac },
          data: {
            status: "ONLINE",
            approvedAt: new Date(),
            approvedBy: actor.username,
            approvedSsid: opts.ssid,
            displayName:
              opts.displayName ??
              existing.displayName ??
              defaultDisplayName(mac, existing.model ?? null),
            failureReason: null,
          },
        });
        // The controller is request/response — there's no routing-service
        // operation to poll, so operationId is null (the dashboard then polls
        // the AP row directly, same as the UNIFI / idempotent DROPLET_IMAGE
        // paths).
        return { ap: updated, operationId: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          { err, mac, ssid: opts.ssid },
          "ap-onboard: EasyMesh approve failed; transitioning to FAILED",
        );
        await prisma.apDevice.update({
          where: { mac },
          data: { status: "FAILED", failureReason: message },
        });
        // Re-throw as the AP-onboard taxonomy. A typed EasyMeshControllerError
        // keeps its message; everything else bubbles a 502 (the controller hop
        // is the gateway), same shape the UNIFI handler uses.
        throw new ApOnboardError(message, 502, "UNKNOWN");
      }
    },

    async decommission(
      prisma: PrismaClient,
      rawMac: string,
    ): Promise<ApMutationResult> {
      const mac = normalizeMac(rawMac);

      const existing = await prisma.apDevice.findUnique({ where: { mac } });
      if (!existing) {
        throw ApOnboardError.notFound(mac);
      }
      if (existing.status === "DECOMMISSIONED") {
        // Idempotent — operator already pulled the trigger. No remove re-fire.
        return { ap: existing, operationId: null };
      }

      try {
        await client.removeAgent(mac);
        const updated = await prisma.apDevice.update({
          where: { mac },
          data: {
            status: "DECOMMISSIONED",
            decommissionedAt: new Date(),
            failureReason: null,
          },
        });
        return { ap: updated, operationId: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ApOnboardError(message, 502, "UNKNOWN");
      }
    },
  };
}

/**
 * EASYMESH backend — IEEE 1905.1 discovery + prplMesh Controller-only M1/M2
 * onboarding (ADR-024 §2). Wired to the config-built controller client
 * (`DROPLET_AP_EASYMESH_CONTROLLER_URL`). The client constructs even with empty
 * config; its calls throw NOT_CONFIGURED until the URL is set, and the discovery
 * source only invokes the backend when `DROPLET_AP_EASYMESH_ENABLED` is on — so
 * a default single-box never touches it.
 */
export const EASYMESH_BACKEND: ApOnboardBackendHandler = createEasyMeshBackend(
  createEasyMeshControllerClient(),
);

// ─────────────────────────────────────────────────────────────────────────
// UNIFI backend (ADR-024 §3, Phase 3) — official-API adopt + WLAN push.
//
// Droplet is a pure API client to a UniFi Network controller the household
// ALREADY runs (Option B — customer-supplied; we never bundle/redistribute
// the controller). The handler drives a `UniFiNetworkClient` and mirrors the
// DROPLET_IMAGE handler's transition + audit discipline EXACTLY:
//   - reconcile : upsert the discovery snapshot (delegates to the shared
//                 dropletImageReconcile — the create path already stamps the
//                 row's `backend`/`backendRef`/`vendor` from each EXPLICIT
//                 observation tag, so a UNIFI observation lands as a UNIFI row).
//   - approve   : adopt-by-MAC THEN push the household WLAN; PROVISIONING →
//                 ONLINE on success (audit columns written), PROVISIONING →
//                 FAILED + failureReason on ANY client error (no partial
//                 ONLINE, no partial WLAN — adopt must complete before push).
//   - decommission : forget the device on the controller → DECOMMISSIONED;
//                 idempotent on an already-DECOMMISSIONED row.
//
// The state transitions are EXPLICIT `ApDeviceStatus` writes (CLAUDE.md
// no-guessing rule), never derived from absence — identical to ADR-005.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build a UNIFI onboarding handler over a given `UniFiNetworkClient`. The
 * client is the seam — production wires the config-built HTTP client, unit
 * tests pass a mock (there is no controller on the dev laptop).
 */
export function createUniFiBackend(
  client: UniFiNetworkClient,
): ApOnboardBackendHandler {
  return {
    key: "UNIFI",

    // The discovery snapshot is reconciled by the same shared upsert path as
    // every other backend — the create path honors each observation's explicit
    // `backend`/`backendRef`/`vendor` tags, so a UNIFI observation becomes a
    // UNIFI row. No per-backend reconcile divergence (one state machine).
    reconcile: dropletImageReconcile,

    async approve(
      prisma: PrismaClient,
      rawMac: string,
      opts: ApproveOptions,
      actor: { username: string },
    ): Promise<ApMutationResult> {
      const mac = normalizeMac(rawMac);

      const existing = await prisma.apDevice.findUnique({ where: { mac } });
      if (!existing) {
        throw ApOnboardError.notFound(mac);
      }

      // Mark provisioning BEFORE the controller calls so the dashboard's
      // polling read sees "spinning" rather than the stale state — same as
      // the DROPLET_IMAGE path.
      await prisma.apDevice.update({
        where: { mac },
        data: { status: "PROVISIONING", failureReason: null },
      });

      try {
        // 1. Adopt by MAC. The controller returns its device_id, which we
        //    persist as backendRef so later operations can address the device.
        const { deviceId } = await client.adoptDevice(mac);
        // 2. Push the household WLAN (SSID + key). Only after adoption — an
        //    unadopted device can't be configured. A throw here leaves the row
        //    FAILED (caught below); we never leave a half-configured ONLINE.
        await client.pushWlanConfig({
          mac,
          ssid: opts.ssid,
          key: opts.encryptionKey,
        });
        const updated = await prisma.apDevice.update({
          where: { mac },
          data: {
            status: "ONLINE",
            approvedAt: new Date(),
            approvedBy: actor.username,
            approvedSsid: opts.ssid,
            backendRef: deviceId,
            displayName:
              opts.displayName ??
              existing.displayName ??
              defaultDisplayName(mac, existing.model ?? null),
            failureReason: null,
          },
        });
        // The official API is request/response — there's no routing-service
        // operation to poll, so operationId is null (the dashboard then polls
        // the AP row directly, same as the idempotent DROPLET_IMAGE paths).
        return { ap: updated, operationId: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          { err, mac, ssid: opts.ssid },
          "ap-onboard: UniFi approve failed; transitioning to FAILED",
        );
        // Roll back the adoption so retry can start from a clean state.
        // Without this, adoptDevice() succeeds but pushWlanConfig() fails,
        // leaving the device adopted on the controller while the DB row is
        // FAILED — a re-adopt on the next retry would error and keep the row
        // stuck indefinitely.
        try {
          await client.forgetDevice(mac);
        } catch (forgetErr) {
          logger.warn(
            { err: forgetErr, mac },
            "ap-onboard: forgetDevice rollback failed — device may still be adopted on the controller",
          );
        }
        await prisma.apDevice.update({
          where: { mac },
          data: { status: "FAILED", failureReason: message },
        });
        // Re-throw as the AP-onboard taxonomy. A typed UniFiClientError keeps
        // its message; everything else bubbles a 502 (the controller hop is
        // the gateway), same shape the DROPLET_IMAGE handler uses.
        throw new ApOnboardError(message, 502, "UNKNOWN");
      }
    },

    async decommission(
      prisma: PrismaClient,
      rawMac: string,
    ): Promise<ApMutationResult> {
      const mac = normalizeMac(rawMac);

      const existing = await prisma.apDevice.findUnique({ where: { mac } });
      if (!existing) {
        throw ApOnboardError.notFound(mac);
      }
      if (existing.status === "DECOMMISSIONED") {
        // Idempotent — operator already pulled the trigger. No forget re-fire.
        return { ap: existing, operationId: null };
      }

      try {
        await client.forgetDevice(mac);
        const updated = await prisma.apDevice.update({
          where: { mac },
          data: {
            status: "DECOMMISSIONED",
            decommissionedAt: new Date(),
            failureReason: null,
          },
        });
        return { ap: updated, operationId: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ApOnboardError(message, 502, "UNKNOWN");
      }
    },
  };
}

/**
 * UNIFI backend — UBNT discovery + UniFi Network API adoption (ADR-024 §3).
 * Wired to the config-built HTTP client (Option B — customer-supplied
 * controller via `DROPLET_AP_UNIFI_CONTROLLER_URL` + `DROPLET_AP_UNIFI_API_KEY`).
 * The client constructs even with empty config; its calls throw
 * NOT_CONFIGURED until both are set, and the discovery source only invokes
 * the backend when `DROPLET_AP_UNIFI_ENABLED` is on — so a default single-box
 * never touches it.
 */
export const UNIFI_BACKEND: ApOnboardBackendHandler = createUniFiBackend(
  createUniFiNetworkClient(),
);

/**
 * The backend registry, keyed by the `ApOnboardBackend` enum value.
 * The single source of truth for "which arrow a row took" (ADR-024
 * Architecture diagram).
 */
export const AP_ONBOARD_BACKENDS: Record<
  ApOnboardBackendKey,
  ApOnboardBackendHandler
> = {
  DROPLET_IMAGE: DROPLET_IMAGE_BACKEND,
  EASYMESH: EASYMESH_BACKEND,
  UNIFI: UNIFI_BACKEND,
};

/**
 * Select the handler for a row's `backend` column. A null / undefined /
 * unrecognised value falls back to DROPLET_IMAGE — the only backend that
 * exists today, and the schema default. This is NOT state-from-absence
 * (the column is explicit and defaulted at the DB level); the fallback
 * only guards against rows seeded before the column existed and against
 * a future enum value the running build doesn't yet know.
 */
export function resolveApBackend(
  backend: string | null | undefined,
): ApOnboardBackendHandler {
  if (backend && backend in AP_ONBOARD_BACKENDS) {
    return AP_ONBOARD_BACKENDS[backend as ApOnboardBackendKey];
  }
  return DROPLET_IMAGE_BACKEND;
}

/**
 * Reconcile a fresh discovery snapshot into ApDevice.
 *
 * Today the only discovery source is the Droplet-image mDNS poller, so
 * this routes straight to the DROPLET_IMAGE backend. Later phases add a
 * discovery multiplexer (ADR-024 Phase 2) that fans the snapshot out per
 * source; the public signature is unchanged so the poller wiring and the
 * ADR-005 tests stay green.
 */
export async function reconcileDiscovered(
  prisma: PrismaClient,
  observed: DiscoveredApObservation[],
): Promise<{ created: number; updated: number; evicted: number }> {
  return DROPLET_IMAGE_BACKEND.reconcile(prisma, observed);
}

/**
 * Approve a discovered AP — routes to the row's backend handler.
 *
 * The row must already exist (it was created by `reconcileDiscovered`);
 * we read its `backend` column and dispatch. Unknown / missing backend
 * defaults to DROPLET_IMAGE (see `resolveApBackend`). The DROPLET_IMAGE
 * handler then runs the unchanged ADR-005 PROVISIONING → ONLINE walk and
 * surfaces `notFound` itself if the MAC isn't present.
 */
export async function approveAp(
  prisma: PrismaClient,
  rawMac: string,
  opts: ApproveOptions,
  actor: { username: string },
): Promise<ApMutationResult> {
  const handler = await resolveBackendForMac(prisma, rawMac);
  return handler.approve(prisma, rawMac, opts, actor);
}

/**
 * Decommission an AP — routes to the row's backend handler. Same
 * dispatch + default-to-DROPLET_IMAGE discipline as `approveAp`.
 */
export async function decommissionAp(
  prisma: PrismaClient,
  rawMac: string,
): Promise<ApMutationResult> {
  const handler = await resolveBackendForMac(prisma, rawMac);
  return handler.decommission(prisma, rawMac);
}

// ─────────────────────────────────────────────────────────────────────
// WARP-1703 — AP band steering (the droplet.wifi.band_steering master
// switch on the Droplet-image AP, shipped in droplet-edge-router PR #5).
//
// Household-level surface: the dashboard toggles "band steering" for the
// home, not per-AP, so these fan across every ONLINE DROPLET_IMAGE row.
// Only the Droplet image carries the substrate — UNIFI / EASYMESH APs
// manage their own steering on their controllers, so their rows are
// excluded by the explicit `backend` filter (never inferred).
// ─────────────────────────────────────────────────────────────────────

export interface ApBandSteeringState {
  /** False = no ONLINE Droplet-image AP (or none of them carry the substrate). */
  supported: boolean;
  enabled: boolean;
}

function toApOnboardError(err: unknown): ApOnboardError {
  if (err instanceof ApOnboardError) return err;
  if (err instanceof RouterError) return ApOnboardError.routerError(err);
  const message = err instanceof Error ? err.message : String(err);
  return new ApOnboardError(message, 502, "UNKNOWN");
}

async function onlineDropletImageAps(prisma: PrismaClient): Promise<{ mac: string }[]> {
  return prisma.apDevice.findMany({
    where: { status: "ONLINE", backend: "DROPLET_IMAGE" },
    select: { mac: true },
  });
}

/**
 * Read the household band-steering state. Honesty contract: zero ONLINE
 * Droplet-image APs → `{ supported: false, enabled: false }` — never an
 * error. With APs present, `supported` is true when at least one reports
 * the substrate, and `enabled` AND-reduces across the supported ones (the
 * household toggle only reads ON when every steerable AP steers).
 */
export async function getBandSteering(
  prisma: PrismaClient,
): Promise<ApBandSteeringState> {
  const rows = await onlineDropletImageAps(prisma);
  if (rows.length === 0) return { supported: false, enabled: false };
  try {
    const states = await Promise.all(
      rows.map((row) => routingGetApBandSteering({ mac: row.mac })),
    );
    const supported = states.filter((s) => s.supported);
    if (supported.length === 0) return { supported: false, enabled: false };
    return { supported: true, enabled: supported.every((s) => s.enabled) };
  } catch (err) {
    throw toApOnboardError(err);
  }
}

/**
 * Toggle band steering on every ONLINE Droplet-image AP. Reads first so an
 * unsupported shape gets the honest 422 (AP_BAND_STEERING_UNAVAILABLE)
 * instead of a confusing write failure; the write then fans across the
 * supported rows only. Returns the last routing operation id (when any) so
 * the dashboard can poll the apply-vs-rollback outcome.
 */
export async function setBandSteering(
  prisma: PrismaClient,
  enabled: boolean,
): Promise<{ operationId: string | null }> {
  const rows = await onlineDropletImageAps(prisma);
  if (rows.length === 0) {
    throw new ApOnboardError(
      "Band steering isn't available — no approved Droplet access point is online.",
      422,
      "AP_BAND_STEERING_UNAVAILABLE",
    );
  }
  try {
    const states = await Promise.all(
      rows.map(async (row) => ({
        mac: row.mac,
        state: await routingGetApBandSteering({ mac: row.mac }),
      })),
    );
    const supported = states.filter((s) => s.state.supported);
    if (supported.length === 0) {
      throw new ApOnboardError(
        "Band steering isn't available — the access point's software doesn't support it yet.",
        422,
        "AP_BAND_STEERING_UNAVAILABLE",
      );
    }
    let operationId: string | null = null;
    // Sequential fan-out: one AP at a time so a failure surfaces before the
    // next write starts (typical deployments have a single external AP).
    for (const target of supported) {
      const result = await routingSetApBandSteering({ mac: target.mac, enabled });
      operationId = result.operationId ?? operationId;
    }
    return { operationId };
  } catch (err) {
    throw toApOnboardError(err);
  }
}

// ─────────────────────────────────────────────────────────────────────
// WARP-1712 — the AP's own network name + passphrase.
//
// ONE SOURCE OF TRUTH. The AP is authoritative for its own radios. These
// functions hold no cached SSID: every read fans out to the AP(s) and
// reports what their uci actually says, so the Network tab's Wi-Fi form and
// the Coverage Extenders card can never disagree with each other or with the
// hardware. `ApDevice.approvedSsid` stays what it has always been — an
// approval-time AUDIT column — and is deliberately not read here.
//
// Household-level, like band steering: the operator names their Wi-Fi once,
// not once per AP, so the write fans across every ONLINE DROPLET_IMAGE row.
// UNIFI / EASYMESH APs manage their own SSIDs on their controllers and are
// excluded by the explicit `backend` filter (never inferred).
// ─────────────────────────────────────────────────────────────────────

export interface ApWifiState {
  /** False = no ONLINE Droplet-image AP, or none of them can report wireless. */
  supported: boolean;
  /** The household network name. Null when the reporting APs disagree. */
  ssid: string | null;
  /** What the APs' band-steer applier calls the 5 GHz network. Display only. */
  fiveGhzSsid: string | null;
  /** The live per-unit passphrase. Null when the APs disagree. */
  key: string | null;
  encryption: string | null;
  bandSteering: boolean | null;
  /** How many ONLINE Droplet-image APs answered with a usable state. */
  apCount: number;
  /**
   * False when the reporting APs are NOT all broadcasting the same name.
   * Surfaced rather than silently picking one — a split household is a real
   * condition an operator needs to see, not something to paper over.
   */
  inSync: boolean;
}

/** Per-AP detail behind an extender card. */
export interface ApWirelessDetail extends ApWireless {
  mac: string;
}

function apWirelessUnavailable(message: string): ApOnboardError {
  return new ApOnboardError(message, 422, "AP_WIRELESS_UNAVAILABLE");
}

/**
 * Read the household's AP Wi-Fi state. Honesty contract: zero ONLINE
 * Droplet-image APs → `{ supported: false, ... }` — never an error.
 *
 * The reduce is deliberately strict about disagreement. With several APs
 * reporting different names we return `inSync: false` and a null ssid instead
 * of picking a winner, because a form pre-filled with one AP's name would
 * silently overwrite the other's on the next save.
 */
export async function getApWifi(prisma: PrismaClient): Promise<ApWifiState> {
  const empty: ApWifiState = {
    supported: false,
    ssid: null,
    fiveGhzSsid: null,
    key: null,
    encryption: null,
    bandSteering: null,
    apCount: 0,
    inSync: true,
  };
  const rows = await onlineDropletImageAps(prisma);
  if (rows.length === 0) return empty;
  try {
    const states = await Promise.all(
      rows.map((row) => routingGetApWireless({ mac: row.mac })),
    );
    const usable = states.filter((s) => s.supported);
    if (usable.length === 0) return empty;

    const first = usable[0];
    const inSync = usable.every((s) => s.ssid === first.ssid);
    return {
      supported: true,
      ssid: inSync ? first.ssid ?? null : null,
      fiveGhzSsid: inSync ? first.five_ghz_ssid ?? null : null,
      key: inSync ? first.key ?? null : null,
      encryption: inSync ? first.encryption ?? null : null,
      // Null when any AP predates the substrate — the household answer is
      // only meaningful when every AP can steer.
      bandSteering: usable.every((s) => s.band_steering === true)
        ? true
        : usable.some((s) => s.band_steering === null)
          ? null
          : false,
      apCount: usable.length,
      inSync,
    };
  } catch (err) {
    throw toApOnboardError(err);
  }
}

/**
 * Set the household network name / passphrase on every ONLINE Droplet-image
 * AP. Reads first so an unsupported shape gets the honest 422 instead of a
 * confusing write failure, then fans out sequentially — one AP at a time so a
 * failure surfaces before the next write starts (typical deployments have a
 * single external AP).
 *
 * Returns the last routing operation id plus the name the APs will broadcast,
 * including the DERIVED 5 GHz name, so the dashboard can tell the operator
 * exactly what to reconnect to without re-reading an AP that is mid-reload.
 */
export async function setApWifi(
  prisma: PrismaClient,
  opts: { ssid?: string; key?: string },
  writtenBy?: string,
): Promise<{ operationId: string | null; ssid: string | null; fiveGhzSsid: string | null }> {
  if (opts.ssid === undefined && opts.key === undefined) {
    throw new ApOnboardError(
      "Provide a network name and/or password — nothing to change.",
      400,
      "AP_INVALID",
    );
  }
  // WARP-1761 (ADR-035 §7) — record the operator's INTENT before anything
  // touches a device, then push exactly as before. This is the one seam, so
  // it covers both callers: the Tier-1 `PUT /network/wifi/ap` and the Tier-2
  // confirm dispatcher in network-status.routes.ts, which replays the params
  // in a separate request. A future third caller cannot bypass it either.
  //
  // Deliberately ABOVE the online-AP lookup: "no approved AP is online" is
  // the lost-write case itself (the lab AP was unreachable for ~20 minutes
  // during a firmware experiment), so the 422 below must not be able to
  // discard what the operator asked for. The intent survives every failure
  // path from here down, and the converger applies it when the AP returns.
  //
  // Best-effort by construction: `recordWifiPrimaryIntent` never throws, so
  // this line cannot change the status, body, or timing contract of any
  // response below it. It records the SSID only — never the passphrase (see
  // network-intent.service.ts).
  await recordWifiPrimaryIntent(prisma, opts, writtenBy);

  const rows = await onlineDropletImageAps(prisma);
  if (rows.length === 0) {
    throw apWirelessUnavailable(
      "Wi-Fi settings aren't available — no approved Droplet access point is online.",
    );
  }
  try {
    const states = await Promise.all(
      rows.map(async (row) => ({
        mac: row.mac,
        state: await routingGetApWireless({ mac: row.mac }),
      })),
    );
    const supported = states.filter((s) => s.state.supported);
    if (supported.length === 0) {
      throw apWirelessUnavailable(
        "Wi-Fi settings aren't available — the access point isn't reporting its wireless configuration.",
      );
    }
    let operationId: string | null = null;
    let ssid: string | null = null;
    let fiveGhzSsid: string | null = null;
    for (const target of supported) {
      const result = await routingSetApWireless({ mac: target.mac, ...opts });
      operationId = result.operationId ?? operationId;
      ssid = result.ssid ?? ssid;
      fiveGhzSsid = result.five_ghz_ssid ?? fiveGhzSsid;
    }
    return { operationId, ssid, fiveGhzSsid };
  } catch (err) {
    throw toApOnboardError(err);
  }
}

/**
 * Per-AP wireless detail for a Coverage Extenders card. Scoped to
 * Droplet-image rows: a UNIFI / EASYMESH AP's radios are its controller's to
 * report, and pretending we can read them over rpcd would be a lie.
 */
export async function getApWirelessForMac(
  prisma: PrismaClient,
  rawMac: string,
): Promise<ApWirelessDetail> {
  const mac = normalizeMac(rawMac);
  const row = await prisma.apDevice.findUnique({ where: { mac } });
  if (!row) throw ApOnboardError.notFound(mac);
  if ((row as { backend?: string }).backend !== "DROPLET_IMAGE") {
    throw apWirelessUnavailable(
      "This access point is managed by its own vendor controller, so Droplet can't read its Wi-Fi settings.",
    );
  }
  try {
    const state = await routingGetApWireless({ mac });
    return { ...state, mac };
  } catch (err) {
    throw toApOnboardError(err);
  }
}

/**
 * Look up the backend handler that owns a given MAC's row. The lookup is
 * cheap (single indexed `findUnique` on the PK) and the handler repeats
 * the same read to fetch the full row + apply not-found semantics — that
 * tiny duplication keeps each handler self-contained (it doesn't trust a
 * row handed in by the router) and is the behavior-preserving choice for
 * Phase 1. A missing row resolves to DROPLET_IMAGE so the handler raises
 * the canonical `ApOnboardError.notFound`, exactly as ADR-005 did.
 */
async function resolveBackendForMac(
  prisma: PrismaClient,
  rawMac: string,
): Promise<ApOnboardBackendHandler> {
  const mac = normalizeMac(rawMac);
  const existing = await prisma.apDevice.findUnique({ where: { mac } });
  return resolveApBackend((existing as { backend?: string } | null)?.backend);
}
