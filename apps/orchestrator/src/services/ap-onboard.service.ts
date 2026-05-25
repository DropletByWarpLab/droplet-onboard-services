/**
 * AP onboarding service — discovery + state-machine transitions for the
 * coverage-extender flow per ADR-005.
 *
 * Layers:
 *   1. `reconcileDiscovered(prisma, observed)` — upserts a fresh mDNS
 *      snapshot into ApDevice. Brand-new MACs land in AWAITING_APPROVAL
 *      (DISCOVERED is reserved for the per-tick interim state — the
 *      poller will collapse it to AWAITING_APPROVAL the same tick).
 *      Existing rows just bump `lastSeen` + any new model/version info.
 *   2. `approveAp(prisma, mac, opts, actor)` — transitions
 *      AWAITING_APPROVAL → PROVISIONING → ONLINE (or FAILED). Pushes
 *      the wireless config through `openwrt.client.approveAp` and
 *      writes the audit columns (`approvedAt`, `approvedBy`,
 *      `approvedSsid`, `lastOperationId`).
 *   3. `decommissionAp(prisma, mac)` — transitions ONLINE →
 *      DECOMMISSIONED. Idempotent on already-DECOMMISSIONED rows.
 *
 * The service owns the state machine; the route layer is a thin
 * dispatch + RBAC veneer.
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

export class ApOnboardError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
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

  static routerError(err: RouterError): ApOnboardError {
    // RouterError statuses already encode the right HTTP semantics
    // (502 = bad-gateway-ish for routing-service failures, 503 for
    // disabled, 504 for timeout); for unknown codes we default to 502
    // since the routing service is the gateway. status is optional on
    // RouterError (network-error path doesn't set one).
    const status = err.status && err.status >= 400 ? err.status : 502;
    return new ApOnboardError(err.message, status, "ROUTER_ERROR");
  }
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
export async function reconcileDiscovered(
  prisma: PrismaClient,
  observed: DiscoveredApObservation[],
): Promise<{ created: number; updated: number }> {
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
  return { created, updated };
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
 * Returns the freshly-updated row so the caller can echo it back.
 */
export async function approveAp(
  prisma: PrismaClient,
  rawMac: string,
  opts: ApproveOptions,
  actor: { username: string },
): Promise<unknown> {
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
    const updated = await prisma.apDevice.update({
      where: { mac },
      data: {
        status: "ONLINE",
        approvedAt: new Date(),
        approvedBy: actor.username,
        approvedSsid: opts.ssid,
        lastOperationId: result.operation_id ?? null,
        displayName: opts.displayName ?? existing.displayName ?? defaultDisplayName(mac, existing.model ?? null),
        failureReason: null,
      },
    });
    return updated;
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
    throw new ApOnboardError(message, 502, "ROUTER_ERROR");
  }
}

/**
 * Decommission an AP. Idempotent on already-DECOMMISSIONED rows (the
 * common operator-double-click case).
 */
export async function decommissionAp(
  prisma: PrismaClient,
  rawMac: string,
): Promise<unknown> {
  const mac = normalizeMac(rawMac);

  const existing = await prisma.apDevice.findUnique({ where: { mac } });
  if (!existing) {
    throw ApOnboardError.notFound(mac);
  }
  if (existing.status === "DECOMMISSIONED") {
    // Idempotent — the operator already pulled the trigger. Return
    // the row unchanged rather than re-firing the routing call.
    return existing;
  }

  try {
    const result = await routingDecommissionAp({ mac });
    const updated = await prisma.apDevice.update({
      where: { mac },
      data: {
        status: "DECOMMISSIONED",
        decommissionedAt: new Date(),
        lastOperationId: result.operation_id ?? null,
        failureReason: null,
      },
    });
    return updated;
  } catch (err) {
    if (err instanceof RouterError) {
      throw ApOnboardError.routerError(err);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ApOnboardError(message, 502, "ROUTER_ERROR");
  }
}

function defaultDisplayName(mac: string, model: string | null): string {
  // "Pi5 AP (12:34:56)" — model + the last 3 octets so the operator
  // can tell two extenders apart in the dashboard before they pick a
  // displayName of their own.
  const last3 = mac.split(":").slice(-3).join(":");
  if (model && model.includes("raspberrypi,5")) return `Pi5 AP (${last3})`;
  if (model) return `${model} AP (${last3})`;
  return `Extender (${last3})`;
}
