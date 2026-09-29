/**
 * Revoking a VPN / overlay peer — the one path shared by `DELETE
 * /api/vpn/peers/:id` and by deactivating or deleting a person (WARP-3160).
 *
 * Order is load-bearing (WARP-2061): HQ first for an overlay peer, so the
 * connect tick can't resurrect it; then the router; then a conditional row
 * flip. Any step that fails leaves the row `active`, so the device list keeps
 * showing a device that is still connected, and the retry stays available.
 */
import { OVERLAY_PEER_USER_ID } from "@droplet/auth-policy";
import { config } from "../config.js";
import {
  deleteVpnPeer,
  isRevokeApplied,
  RouterError,
} from "./openwrt.client.js";
import { revokeOverlayDeviceAtHq } from "./overlay-connect.service.js";
import { createDeviceIdentityClient } from "./device-identity.client.js";
import { recordActivity } from "./activity.singleton.js";
import type { ActivityActor } from "./activity.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("vpn-peer-revoke");

export type OverlayRevokeFn = (wgPublicKey: string) => Promise<void>;

/** WARP-2061 — the box→HQ revocation call over the device-identity PoP. */
export function defaultOverlayRevoke(wgPublicKey: string): Promise<void> {
  return revokeOverlayDeviceAtHq(
    {
      config: {
        hqBaseUrl: config.HQ_ISSUANCE_URL,
        deviceId: config.DROPLET_DEVICE_ID,
      },
      identity: createDeviceIdentityClient(),
    },
    wgPublicKey,
  );
}

export interface RevocablePeer {
  id: string;
  publicKey: string;
  kind: string;
  userId: string;
  deviceLabel?: string | null;
}

/** `revoked` also covers "already gone on the router" and "someone else
 *  revoked it first" — the same terminal state. */
export type PeerRevokeOutcome =
  | "revoked"
  /** WARP-3172: router + row revoked, HQ unreachable; `hqRevokePending` set. */
  | "REVOKED_HQ_PENDING"
  | "HQ_REVOKE_FAILED"
  | "REVOKE_STAGED";

export interface PeerRevokePrisma {
  vpnPeer: {
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
}

/**
 * Revoke one peer. Throws only on an unexpected router fault.
 *
 * `continueOnHqFailure` (WARP-3172) is for a leaver: their account is already
 * gone, so a still-live router peer is the worse outcome. The router peer is
 * removed anyway and the row flagged `hqRevokePending`; the connect tick
 * refuses the device (inactive owner) and retries the HQ revoke. The manual
 * revoke route keeps the strict WARP-2061 behaviour (nothing changes, retry).
 */
export async function revokeVpnPeer(
  deps: { prisma: PeerRevokePrisma; overlayRevoke: OverlayRevokeFn },
  peer: RevocablePeer,
  opts: { continueOnHqFailure?: boolean } = {},
): Promise<PeerRevokeOutcome> {
  let hqPending = false;
  if (peer.kind === "overlay") {
    try {
      await deps.overlayRevoke(peer.publicKey);
    } catch (err) {
      if (!opts.continueOnHqFailure) {
        logger.error(
          { err, peerId: peer.id },
          "vpn: HQ overlay revoke failed — device left enrolled; nothing revoked locally either",
        );
        return "HQ_REVOKE_FAILED";
      }
      logger.error(
        { err, peerId: peer.id },
        "vpn: HQ overlay revoke failed — removing the router peer anyway and flagging the row for an HQ retry",
      );
      hqPending = true;
    }
  }
  try {
    const removal = await deleteVpnPeer({ publicKey: peer.publicKey });
    // A staged-but-unapplied removal leaves the peer live on wg0; keep the row
    // active so nobody is told a still-connected device is cut off.
    if (!isRevokeApplied(removal)) {
      logger.error(
        { peerId: peer.id, removed: removal.removed },
        "vpn: router staged the peer removal but never applied it — peer is still live on the interface; row left active",
      );
      return "REVOKE_STAGED";
    }
  } catch (err) {
    if (!(err instanceof RouterError && err.status === 404)) throw err;
    logger.warn({ peerId: peer.id }, "vpn: peer already gone on router — marking row revoked anyway");
  }
  // Conditional flip: a concurrent revoke is the same terminal state, and its
  // `revokedAt` is not re-stamped.
  await deps.prisma.vpnPeer.updateMany({
    where: { id: peer.id, status: "active" },
    data: {
      status: "revoked",
      revokedAt: new Date(),
      ...(hqPending ? { hqRevokePending: true } : {}),
    },
  });
  return hqPending ? "REVOKED_HQ_PENDING" : "revoked";
}

export interface UserDeviceRevokePrisma extends PeerRevokePrisma {
  vpnPeer: PeerRevokePrisma["vpnPeer"] & {
    findMany(args: { where: Record<string, unknown> }): Promise<RevocablePeer[]>;
  };
  pendingOverlayEnrollment: {
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
}

export interface UserDeviceRevokeSummary {
  /** Cut off on the box (includes REVOKED_HQ_PENDING). */
  revoked: number;
  /** Still live on the router — the admin must retry from the device list. */
  failed: number;
  /** Cut off on the box, HQ revoke owed (retried by the connect tick). */
  hqPending: number;
  pendingDenied: number;
}

export type DeviceRevokeReason = "deactivation" | "removal" | "role_change";

/**
 * WARP-3160 — a person who is deactivated or deleted loses every VPN device
 * they own, and any device still waiting for owner review is denied.
 *
 * Best-effort by design: the directory write has already committed and must
 * not be undone by an HQ or router outage. Every peer gets its own signed
 * audit row naming the admin, the reason and the outcome; a failure is left
 * `active` in the device list for the admin to retry.
 */
export async function revokeUserVpnDevices(
  prisma: UserDeviceRevokePrisma,
  args: {
    username: string;
    actor: ActivityActor;
    reason: DeviceRevokeReason;
    overlayRevoke?: OverlayRevokeFn;
  },
): Promise<UserDeviceRevokeSummary> {
  const summary: UserDeviceRevokeSummary = { revoked: 0, failed: 0, hqPending: 0, pendingDenied: 0 };
  // The synthetic owner of QR-linked devices is not a person; never sweep it.
  if (!args.username || args.username === OVERLAY_PEER_USER_ID) return summary;
  const overlayRevoke = args.overlayRevoke ?? defaultOverlayRevoke;

  try {
    const denied = await prisma.pendingOverlayEnrollment.updateMany({
      where: { requestedBy: args.username, state: "pending" },
      data: { state: "denied" },
    });
    summary.pendingDenied = denied.count;
  } catch (err) {
    logger.error({ err, username: args.username }, "WARP-3160: denying pending enrollments failed");
  }

  let peers: RevocablePeer[];
  try {
    peers = await prisma.vpnPeer.findMany({
      where: { userId: args.username, status: "active" },
    });
  } catch (err) {
    logger.error({ err, username: args.username }, "WARP-3160: listing the person's VPN devices failed — none revoked");
    return summary;
  }

  for (const peer of peers) {
    let outcome: PeerRevokeOutcome | "ERROR";
    try {
      outcome = await revokeVpnPeer({ prisma, overlayRevoke }, peer, {
        continueOnHqFailure: true,
      });
    } catch (err) {
      logger.error({ err, peerId: peer.id }, "WARP-3160: device revoke failed");
      outcome = "ERROR";
    }
    if (outcome === "revoked" || outcome === "REVOKED_HQ_PENDING") summary.revoked += 1;
    else summary.failed += 1;
    if (outcome === "REVOKED_HQ_PENDING") summary.hqPending += 1;
    void recordActivity({
      kind: "network",
      severity: "warn",
      sourceIcon: "shield",
      what:
        outcome === "revoked" || outcome === "REVOKED_HQ_PENDING"
          ? `${peer.deviceLabel ?? "Device"} lost remote access`
          : `${peer.deviceLabel ?? "Device"} could not be revoked — revoke it from the device list`,
      sub: `${args.username}: ${args.reason}`,
      actor: args.actor,
      refs: {
        event: "overlay_revoke",
        reason: args.reason,
        outcome,
        peer_id: peer.id,
        kind: peer.kind,
        device_owner: peer.userId,
        label: peer.deviceLabel ?? null,
      },
    });
  }
  return summary;
}

// --- Process-wide entry point (WARP-3160) ---------------------------------
//
// The lifecycle post-effects (disable, delete, role change, SCIM, the leaver
// hand-over flow) carry no Prisma client, so the box wires one here at boot,
// next to initActivityRecorder. Same pattern as activity.singleton.

let boundPrisma: UserDeviceRevokePrisma | null = null;

export function initVpnDeviceRevoke(prisma: UserDeviceRevokePrisma): void {
  boundPrisma = prisma;
}

/**
 * Revoke every VPN device `username` owns and deny their pending enrollments,
 * auditing each with `actor` and `reason`. Best-effort; never throws. Returns
 * null when the box has not wired a client (unit tests), logged loudly.
 */
export async function revokeOverlayDevicesForUser(
  username: string,
  actor: ActivityActor,
  reason: DeviceRevokeReason,
): Promise<UserDeviceRevokeSummary | null> {
  if (!boundPrisma) {
    logger.error(
      { username, reason },
      "WARP-3160: device revoke not wired (initVpnDeviceRevoke) — the person's VPN devices were NOT revoked",
    );
    return null;
  }
  return revokeUserVpnDevices(boundPrisma, { username, actor, reason });
}
