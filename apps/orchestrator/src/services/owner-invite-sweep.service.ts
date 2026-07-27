/**
 * WARP-1565 residual 2 — revoke pending pre-narrowing owner invites.
 *
 * Rail 7 (`assertRoleAssignable`, WARP-1526) closed the MINT path: both
 * invite-creating routes now refuse `role: "owner"` with 403
 * ROLE_NOT_ASSIGNABLE — there is exactly one owner by design, and ownership
 * transfer is a future dedicated flow, not a role assignment.
 *
 * It could not do anything about rows already written. An invite created
 * before that narrowing is still `role="owner"`, still pending, and accept
 * still honours it — DELIBERATELY. The WARP-1051 contract is that accept
 * grants the invite's canonical role with no silent remapping, and
 * `auth.directory-invite-accept.test.ts` pins the owner passthrough
 * explicitly. So the fix removes the INPUT rather than changing the
 * enforcement point: with no pending owner invite in the table, there is
 * nothing for the passthrough to pass through.
 *
 * A BOOT SWEEP, not a migration, and that is the substantive choice here. A
 * migration fixes the rows present when it runs. This box gets reflashed and
 * restored from backup, so a restore of a pre-narrowing dump would put a
 * pending owner invite back in front of an accept path that is documented to
 * honour it. Converging on every boot is what makes that unreachable, and
 * the sweep costs one indexed UPDATE against a table with tens of rows.
 *
 * Selection is on the EXPLICIT columns the invite state machine defines
 * (`acceptedAt` / `revokedAt`, per invite.service's Pending → Accepted /
 * Expired / Revoked). Expiry is deliberately NOT part of the predicate: an
 * expired-but-unrevoked row is still Pending in the column sense, and
 * `expiresAt < now()` is a clock comparison, not stored state — revoking it
 * too is both correct and cheaper than reasoning about clock skew.
 */
import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("owner-invite-sweep");

/**
 * Revoke every pending `role="owner"` invite. Idempotent: a revoked row no
 * longer matches, so a second boot updates nothing and never re-stamps
 * `revokedAt`. Returns how many rows this run revoked.
 *
 * Accepted invites are untouched: that person already holds the role, so
 * revoking would take nothing away, and back-dating their invite record
 * would put a false statement in the audit trail.
 */
export async function revokePendingOwnerInvites(
  prisma: PrismaClient,
): Promise<number> {
  const { count } = await prisma.userInvite.updateMany({
    where: { role: "owner", acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  if (count > 0) {
    // WARN, not INFO: on a converged box this is always zero, so a non-zero
    // count means a pre-narrowing invite reached this deployment — worth an
    // operator noticing, because someone is holding a link that has just
    // stopped working and will need re-inviting at an assignable tier.
    logger.warn(
      { count },
      "revoked pending owner invite(s) — owner is not an assignable invite role (WARP-1526 rail 7); re-invite at admin if access is still needed",
    );
  }
  return count;
}
