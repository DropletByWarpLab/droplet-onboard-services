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
export type PeerRevokeOutcome = "revoked" | "HQ_REVOKE_FAILED" | "REVOKE_STAGED";

export interface PeerRevokePrisma {
  vpnPeer: {
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
}

/** Revoke one peer. Throws only on an unexpected router fault. */
export async function revokeVpnPeer(
  deps: { prisma: PeerRevokePrisma; overlayRevoke: OverlayRevokeFn },
  peer: RevocablePeer,
): Promise<PeerRevokeOutcome> {
  if (peer.kind === "overlay") {
    try {
      await deps.overlayRevoke(peer.publicKey);
    } catch (err) {
      logger.error(
        { err, peerId: peer.id },
        "vpn: HQ overlay revoke failed — device left enrolled; nothing revoked locally either",
      );
      return "HQ_REVOKE_FAILED";
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
    data: { status: "revoked", revokedAt: new Date() },
  });
  return "revoked";
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
  revoked: number;
  failed: number;
  pendingDenied: number;
}

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
    reason: "deactivation" | "removal";
    overlayRevoke?: OverlayRevokeFn;
  },
): Promise<UserDeviceRevokeSummary> {
  const summary: UserDeviceRevokeSummary = { revoked: 0, failed: 0, pendingDenied: 0 };
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
      outcome = await revokeVpnPeer({ prisma, overlayRevoke }, peer);
    } catch (err) {
      logger.error({ err, peerId: peer.id }, "WARP-3160: device revoke failed");
      outcome = "ERROR";
    }
    if (outcome === "revoked") summary.revoked += 1;
    else summary.failed += 1;
    void recordActivity({
      kind: "network",
      severity: "warn",
      sourceIcon: "shield",
      what:
        outcome === "revoked"
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
