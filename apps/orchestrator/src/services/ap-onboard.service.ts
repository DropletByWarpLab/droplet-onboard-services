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
import pino from "pino";
import { normalizeMac } from "../lib/mac.js";
import {
  approveAp as routingApproveAp,
  decommissionAp as routingDecommissionAp,
  RouterError,
} from "./openwrt.client.js";

const logger = pino({ name: "ap-onboard" });

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
  model?: string;
  serial?: string;
  version?: string;
  lastIp?: string;
  hostname?: string;
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
        // ADR-024: mDNS `_droplet-ap._tcp` is today's only discovery
        // source, so a freshly reconciled row is always DROPLET_IMAGE.
        // Explicit column, never derived (CLAUDE.md no-guessing rule).
        backend: "DROPLET_IMAGE",
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
 * Thrown by the EASYMESH / UNIFI stubs. Surfaces as a 501 so a caller
 * that somehow routes a non-DROPLET_IMAGE row this phase gets an honest
 * "not built yet" rather than a silent mis-dispatch.
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

/**
 * Build a NotImplemented stub for a backend whose phase hasn't landed.
 * The registry entry is REAL (so dispatch can find it and the shape is
 * exercised) but every operation throws — no behavior is added.
 */
function notImplementedBackend(
  key: Extract<ApOnboardBackendKey, "EASYMESH" | "UNIFI">,
): ApOnboardBackendHandler {
  return {
    key,
    async reconcile(): Promise<never> {
      throw new ApBackendNotImplementedError(key, "reconcile");
    },
    async approve(): Promise<never> {
      throw new ApBackendNotImplementedError(key, "approve");
    },
    async decommission(): Promise<never> {
      throw new ApBackendNotImplementedError(key, "decommission");
    },
  };
}

/**
 * EASYMESH backend — IEEE 1905.1 discovery + prplMesh-controller M1/M2
 * onboarding (ADR-024 §2). Stub until Phase 4.
 */
export const EASYMESH_BACKEND: ApOnboardBackendHandler =
  notImplementedBackend("EASYMESH");

/**
 * UNIFI backend — UBNT UDP 10001 discovery + UniFi Network API adoption
 * (ADR-024 §3). Stub until Phase 3.
 */
export const UNIFI_BACKEND: ApOnboardBackendHandler =
  notImplementedBackend("UNIFI");

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
