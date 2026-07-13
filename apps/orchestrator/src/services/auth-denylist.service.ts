/**
 * WARP-490 — access-token denylist (immediate user revocation).
 *
 * Problem: deleting (or offboarding) a user removes their local `User`
 * row and, via `revokeAllSessions`, their session RECORDS + refresh-token
 * denylist. But an access token that was ALREADY issued keeps verifying on
 * its own signature until it self-expires (≤ACCESS_TOKEN_TTL_SECONDS). For a
 * deletion driven by "this account is compromised, cut it off NOW" that lag
 * is unacceptable.
 *
 * Fix: a per-user denylist in Redis. `DELETE /api/people/:id` (and any other
 * hard-revocation path) writes `auth:denylist:user:<userId>` with a TTL equal
 * to the max access-token age. `authMiddleware` checks it on every verified
 * JWT and 401s immediately when the subject is listed. After the TTL elapses,
 * every access token that could have been outstanding at revocation time has
 * expired on its own, so the entry self-cleans — there is nothing for a cron
 * to sweep (the Redis TTL IS the sweep), which keeps us clear of the
 * `while True` scheduling rule.
 *
 * This complements `revokeAllSessions` rather than replacing it:
 *   • revokeAllSessions kills sid-carrying tokens at the next request (the
 *     session record is gone → checkSession returns "missing") and denylists
 *     the refresh tokens.
 *   • this denylist ALSO catches sid-LESS grace-path tokens (which skip
 *     checkSession entirely) and fires BEFORE the session lookup, so a
 *     compromised subject is cut off even if the session sweep raced or
 *     partially failed.
 *
 * Key shape (explicit SET key, never derived from absence — honors the
 * "no IS-NULL state" rule): `auth:denylist:user:<userId>`.
 */
import { cacheGet, cacheSet } from "./cache.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("auth-denylist");

const DENYLIST_KEY_PREFIX = "auth:denylist:user:";

function denylistKey(userId: string): string {
  return `${DENYLIST_KEY_PREFIX}${userId}`;
}

/**
 * Add `userId` to the access-token denylist for `ttlSeconds`. Callers pass
 * `ACCESS_TOKEN_TTL_SECONDS` so the entry lives exactly as long as the
 * longest-lived access token that could have been outstanding when the
 * revocation happened — after that every such token has expired naturally.
 *
 * Best-effort (mirrors `revokeAllSessions`): a Redis write failure is logged
 * but does NOT fail the caller's mutation (the user row is already deleted;
 * the sid-carrying tokens are still revoked by the session sweep, and the
 * access token self-expires in ≤ttlSeconds regardless).
 */
export async function denylistUser(
  userId: string,
  ttlSeconds: number,
): Promise<void> {
  try {
    // The stored value is irrelevant — presence is the signal. "1" keeps the
    // payload minimal.
    await cacheSet(denylistKey(userId), 1, ttlSeconds);
    logger.info({ userId, ttlSeconds }, "user added to access-token denylist");
  } catch (err) {
    // Self-contained best-effort: cache.service.cacheSet already swallows
    // Redis errors, but a denylist write must NEVER fail the caller's
    // mutation — the user row is already gone and the token self-expires in
    // ≤ttlSeconds regardless. Guard here too so the contract holds even if
    // cacheSet's posture ever changes.
    logger.warn({ err, userId }, "denylist write failed (non-fatal)");
  }
}

/**
 * True when `userId` is on the denylist. Fails OPEN (returns false) on a Redis
 * error or a missing client — the SAME availability posture as `checkSession`:
 * a cache outage must not brick every authenticated route, and during such an
 * outage `revokeAllSessions` is degraded too, so the whole revocation surface
 * fails open consistently. The access token still self-expires in ≤TTL. This
 * is why the denylist is defense-in-depth, not the sole revocation control.
 *
 * `cacheGet` already swallows Redis errors and returns null, so a null read is
 * indistinguishable from "not listed" — both mean "let the request proceed".
 */
export async function isUserDenied(userId: string): Promise<boolean> {
  const hit = await cacheGet<number>(denylistKey(userId));
  return hit !== null;
}
