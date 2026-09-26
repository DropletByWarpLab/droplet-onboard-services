/**
 * Invite token generation, comparison, and state-machine predicates for
 * WARP-217. Tokens are URL-safe base64 of 32 random bytes — long enough to
 * resist brute-force enumeration over the full validity window. Comparison
 * is constant-time (`crypto.timingSafeEqual`) to neutralise timing oracles
 * over the database lookup; equal-length is checked first because
 * `timingSafeEqual` throws on length mismatch.
 *
 * State machine (Pending is the only non-terminal), held in the explicit
 * `UserInvite.status` column (WARP-3193 QUAL-3 — never derived from the
 * timestamps, which are stamped alongside it as audit detail):
 *   pending  → accepted    (accept route; acceptedAt stamped with it)
 *   pending  → expired     (daily sweep, expireOverdueInvites; readers also
 *                           reject a pending row past expiresAt in real time)
 *   pending  → revoked     (revoke route / owner-invite sweep; revokedAt)
 *
 * `findInviteByToken` is the only DB-touching helper here; the route layer
 * still owns transaction semantics on accept (so we can update + create the
 * Nextcloud user atomically as far as our DB is concerned).
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { PrismaClient, UserInvite } from "@prisma/client";

/** Fresh URL-safe base64 token (no padding). 32 bytes → 43 chars. */
export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Compare two tokens in constant time relative to their length. Different
 * lengths short-circuit to `false` (we can't pass mismatched buffers to
 * `timingSafeEqual` — it throws). The constant-time guarantee is per-length
 * class, which is the same guarantee Node's own internal token comparators
 * give.
 */
export function compareTokensConstantTime(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false; // belt-and-braces
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Look up an invite by its raw token, comparing the stored token in
 * constant time to defeat per-row timing oracles. Returns null if no row
 * matches OR the stored token fails comparison (defense in depth — Prisma
 * already does an equality match upstream).
 */
export async function findInviteByToken(
  prisma: PrismaClient,
  token: string,
): Promise<UserInvite | null> {
  if (!token || typeof token !== "string") return null;
  const row = await prisma.userInvite.findUnique({ where: { token } });
  if (!row) return null;
  return compareTokensConstantTime(row.token, token) ? row : null;
}

/**
 * `expiresAt` stays authoritative for the deadline between sweeps: a pending
 * row past it is expired now, before the 03:00 sweep stamps the status
 * (PairingCodeStatus precedent).
 */
export function isExpired(invite: Pick<UserInvite, "status" | "expiresAt">): boolean {
  return invite.status === "expired" || invite.expiresAt.getTime() < Date.now();
}

export function isUsed(invite: Pick<UserInvite, "status">): boolean {
  return invite.status === "accepted";
}

export function isRevoked(invite: Pick<UserInvite, "status">): boolean {
  return invite.status === "revoked";
}

/**
 * WARP-3193 QUAL-3 — the pending→expired transition write, run from the
 * 03:00 daily purge. Bookkeeping, not enforcement: readers already reject an
 * overdue pending row via `isExpired`. Idempotent (a re-run matches nothing).
 */
export async function expireOverdueInvites(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const { count } = await prisma.userInvite.updateMany({
    where: { status: "pending", expiresAt: { lt: now } },
    data: { status: "expired" },
  });
  return count;
}
