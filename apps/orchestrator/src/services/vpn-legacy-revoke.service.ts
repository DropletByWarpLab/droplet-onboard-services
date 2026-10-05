/** Finish fleet revocations already owed by legacy devices, without connecting any device. */
import { defaultOverlayRevoke, type OverlayRevokeFn } from "./vpn-peer-revoke.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("vpn-legacy-revoke");

export interface LegacyRevokePrisma {
  vpnPeer: {
    findMany(args: {
      where: { kind: "overlay"; status: "revoked"; hqRevokePending: true };
      select: { id: true; publicKey: true };
      take: number;
    }): Promise<Array<{ id: string; publicKey: string }>>;
    updateMany(args: {
      where: { id: string; status: "revoked"; hqRevokePending: true };
      data: { hqRevokePending: false };
    }): Promise<{ count: number }>;
  };
}

/** Bounded debt sweep: revoked rows only; no router install or fleet enrollment. */
export async function retryPendingLegacyOverlayRevokes(
  prisma: LegacyRevokePrisma,
  revoke: OverlayRevokeFn = defaultOverlayRevoke,
): Promise<{ completed: number; failed: number }> {
  const peers = await prisma.vpnPeer.findMany({
    where: { kind: "overlay", status: "revoked", hqRevokePending: true },
    select: { id: true, publicKey: true },
    take: 100,
  });
  const result = { completed: 0, failed: 0 };
  for (const peer of peers) {
    try {
      await revoke(peer.publicKey);
      await prisma.vpnPeer.updateMany({
        where: { id: peer.id, status: "revoked", hqRevokePending: true },
        data: { hqRevokePending: false },
      });
      result.completed += 1;
    } catch (err) {
      result.failed += 1;
      logger.warn({ err, peerId: peer.id }, "legacy device fleet revocation still pending");
    }
  }
  return result;
}
