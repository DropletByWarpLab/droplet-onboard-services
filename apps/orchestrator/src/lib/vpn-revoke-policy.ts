/**
 * WARP-3121 — who may revoke a VPN peer (`DELETE /api/vpn/peers/:id`).
 *
 * Before WARP-3121 the route sat behind `requireRole("owner", "admin")`. It
 * now has one per-resource exception, so the rule lives here as a pure
 * function the route and the RBAC matrix both use:
 *
 *   • no session / no role          → refused (as requireRole did)
 *   • owner, admin                  → any peer
 *   • family (member), guest        → only an OVERLAY peer whose `userId` is
 *                                     their own username. Revoking only ever
 *                                     reduces access, so a guest may remove
 *                                     their own device too.
 *   • service principals, any other → refused, even if a row happens to carry
 *     role                             their username (requireRole parity)
 *
 * The overlay placeholder owner (`OVERLAY_PEER_USER_ID`, shared by every
 * QR-linked device) never counts as "own", whatever the caller is named.
 */
import { OVERLAY_PEER_USER_ID } from "@droplet/auth-policy";

export type PeerRevokeDecision = "admin" | "own" | "no-role" | "not-yours";

const ADMIN_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);
const OWN_DEVICE_ROLES: ReadonlySet<string> = new Set(["family", "guest"]);

export function decidePeerRevoke(
  user: { role?: string; username?: string } | undefined,
  peer: { kind: string; userId: string },
): PeerRevokeDecision {
  const role = user?.role;
  if (!role) return "no-role";
  if (ADMIN_ROLES.has(role)) return "admin";
  const own =
    OWN_DEVICE_ROLES.has(role) &&
    peer.kind === "overlay" &&
    peer.userId !== OVERLAY_PEER_USER_ID &&
    !!user?.username &&
    peer.userId === user.username;
  return own ? "own" : "not-yours";
}
