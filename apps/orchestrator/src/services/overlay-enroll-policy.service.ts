/**
 * WARP-1882 — whether a device that signs in is set up immediately, or waits.
 *
 * The default is immediate, and that is the product decision: remote access
 * should not be a feature you configure, so signing in on a device is the
 * whole ceremony. Someone who has already proved who they are should not then
 * be made to wait for a second approval of the same fact.
 *
 * The toggle exists for deployments that want a stricter posture — a business
 * where the person with the password is not automatically the person who
 * decides which machines reach the network. Turning it on does NOT invent a
 * second queue: a bearer enrollment is staged into the same
 * `PendingOverlayEnrollment` table the QR flow uses, and surfaces in the same
 * owner review list, with the same approve/deny routes. One queue, two ways in.
 *
 * Stored as a `WorkspaceSetting` in the `off_lan` section, which the schema
 * already describes as "VPN / remote-access posture". No migration: the row is
 * created on first write, and its absence is the default.
 */

export const OVERLAY_REQUIRE_APPROVAL_KEY = "off_lan.overlay_require_approval";

/** Structural — the routes pass their PrismaClient, tests pass a stub. */
export interface OverlayPolicyPrisma {
  workspaceSetting: {
    findUnique(args: {
      where: { key: string };
      select: { valueJson: true };
    }): Promise<{ valueJson: unknown } | null>;
  };
}

/**
 * Does a signed-in device need the owner's approval before it is set up?
 *
 * Reads STRICTLY: only a literal `true` turns the gate on. A missing row, a
 * malformed value, or a string `"true"` all mean off.
 *
 * That asymmetry is deliberate and it is worth being explicit about which way
 * it fails. Reading loosely — treating any truthy JSON as "on" — would mean a
 * corrupted or half-written row silently switches a household into a mode
 * where new devices stop working and nothing says why. Reading strictly means
 * the same corruption silently leaves the gate OFF, which is the weaker
 * security posture but the one the product ships as its default anyway. The
 * failure is toward the documented default, not toward a surprising one.
 *
 * A deployment that genuinely needs the gate to be load-bearing should not be
 * relying on a boolean in a settings table for it; that is what the QR flow
 * is, and it remains available.
 */
export async function overlayRequiresApproval(
  prisma: OverlayPolicyPrisma,
): Promise<boolean> {
  try {
    const row = await prisma.workspaceSetting.findUnique({
      where: { key: OVERLAY_REQUIRE_APPROVAL_KEY },
      select: { valueJson: true },
    });
    return row?.valueJson === true;
  } catch {
    // The settings table being unreadable must not take remote access down
    // with it. Same reasoning as above: fall to the documented default.
    return false;
  }
}
