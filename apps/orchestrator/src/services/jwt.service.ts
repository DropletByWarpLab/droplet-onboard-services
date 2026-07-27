import { createHash, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import {
  cacheGet,
  cacheSet,
  cacheSetNx,
  cacheDel,
  cacheSetAdd,
  cacheSetRemove,
  cacheSetMembers,
} from "./cache.service.js";

export type Role = "owner" | "admin" | "family" | "guest" | "service";

export interface JwtPayload {
  sub: string;
  username: string;
  displayName: string;
  role: Role;
  /**
   * PR #375 — ISO timestamp of the most-recent successful MFA challenge
   * (TOTP code or recovery code at login). Optional: only present when the
   * session was minted behind a second factor. The auth middleware copies
   * it onto `req.user.lastMfaAt` so `require-recent-mfa` (WARP-230) can
   * gate sensitive routes. Absent for password-only sessions.
   */
  lastMfaAt?: string;
  /**
   * WARP-247 — server-side session record id. Present on every token minted
   * after session hardening shipped; the auth middleware loads
   * `sess:rec:{sid}` to enforce idle/absolute timeouts and revocation.
   * Absent on legacy tokens (pre-deploy), which get a bounded grace path:
   * access tokens self-expire in ≤15 min, refresh is refused outright.
   */
  sid?: string;
  /**
   * WARP-1582 — the holder's assigned custom access role at mint time.
   *
   * THREE-STATE, and the distinction is the safety property:
   *
   *   `undefined` — claim ABSENT. A legacy token, or a mint site that
   *                 does not supply it. Means "unknown": every consumer
   *                 must resolve against the database.
   *   `null`      — claim PRESENT: this person holds no custom access
   *                 role. The ONLY value a consumer may act on, and only
   *                 to skip work (see `resolveToolAccessScope`).
   *   `string`    — claim PRESENT and names a role. Observability only —
   *                 the role's grants still have to be read, so nothing
   *                 is ever authorised from this value.
   *
   * `null` and `undefined` collapse under `??`, `?.`, `!x` and JSON
   * round-trips. Keeping them apart is deliberate: reading an absent
   * claim as "no custom role" is a fail-OPEN bug that would drop the
   * WARP-1529 per-role tool narrowing for every pre-deploy token.
   */
  accessRoleId?: string | null;
}

// Single source of truth for token lifetimes. Both the jwt `expiresIn` option
// and the cookie `maxAge` derive from these — keep them in sync here only.
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

const REFRESH_DENYLIST_PREFIX = "jwt:deny:";
const REFRESH_LOCK_PREFIX = "jwt:rotate:";

// WARP-116: per-user index of live refresh-token sessions. A Redis set whose
// members are `${tokenHash}:${exp}` so the revoke path can rebuild each
// token's remaining TTL from the member alone (the raw token is never stored).
const SESSION_SET_PREFIX = "jwt:sessions:";

const VALID_ROLES: readonly Role[] = ["owner", "admin", "family", "guest", "service"] as const;

/**
 * Derive a role from a Nextcloud group list.
 * Single source of truth — used at login and in the Nextcloud OCS fallback.
 * See ADR-004 §4 for the mapping.
 */
export function roleFromGroups(groups: string[]): Role {
  if (groups.includes("admin")) return "owner";
  if (groups.includes("staff")) return "admin";
  if (groups.includes("guest")) return "guest";
  return "family";
}

/**
 * Privilege ladder for the household role taxonomy (ADR-004 §3). Higher
 * number = more authority. Used to stop a lower-ranked operator from
 * minting an invite that assigns a role outranking their own — the
 * privilege-escalation vector on the invite-creation routes (since
 * WARP-1051 the accept path grants the invite's canonical role as the
 * session role, so the cap is what keeps an admin from minting owners).
 *
 * Mirrors the ascending ladder in `scim-role-mapping.service.ts`
 * (`ROLE_PRIVILEGE`, the SCIM directory branch) — keep the two in sync
 * until they're unified. `service` is the non-human inbound principal: it
 * sits at the floor so it can never outrank a human role in a comparison,
 * and it is never invite-assignable (the invite role enum excludes it)
 * nor clears the owner/admin route guard, so it only appears here for
 * total coverage of the Role union.
 */
export const ROLE_RANK: Record<Role, number> = {
  service: -1,
  guest: 0,
  family: 1,
  admin: 2,
  owner: 3,
};

/**
 * True iff role `a` holds strictly more privilege than role `b`. Drives
 * the invite-creation rank cap: reject when the assigned role outranks
 * the authenticated inviter's own role (owner→owner is allowed; an admin
 * may not mint an owner invite).
 */
export function roleOutranks(a: Role, b: Role): boolean {
  return ROLE_RANK[a] > ROLE_RANK[b];
}

/**
 * Is `value` one of the canonical Role vocabulary values? Runtime guard for
 * rank-checking role strings that arrive OUTSIDE a zod-validated body — e.g.
 * the WARP-1523 role-UPDATE cap on PUT /auth/users/:username reads the raw
 * body because updateUserSchema strips unknown keys. Exact lowercase match
 * (mirrors isInviteRole's shape); never consults the prototype chain.
 */
export function isRole(value: unknown): value is Role {
  return (
    typeof value === "string" &&
    (VALID_ROLES as readonly string[]).includes(value)
  );
}

function getSecret(): string {
  return config.JWT_SECRET;
}

/**
 * Sign a short-lived access token (15 min).
 * Access tokens carry `type: "access"` to prevent confusion with refresh tokens.
 */
export function signAccessToken(user: {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  /** PR #375 — stamp when this session passed a TOTP/recovery challenge. */
  lastMfaAt?: string;
  /** WARP-247 — server-side session record id (sess:rec:{sid}). */
  sid?: string;
  /** WARP-1582 — assigned custom access role, read from the User row at
   *  mint time. Pass `null` for "no custom role"; OMIT the property when
   *  the caller genuinely does not know, which keeps the old token shape
   *  and makes consumers fall back to the database. */
  accessRoleId?: string | null;
}): string {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      // Only include the claim when present so password-only sessions
      // (and every existing caller) keep their current token shape.
      ...(user.lastMfaAt ? { lastMfaAt: user.lastMfaAt } : {}),
      ...(user.sid ? { sid: user.sid } : {}),
      // WARP-1582 — `!== undefined`, NOT a truthiness test: `null` is a
      // meaningful value here ("no custom role") and must be emitted.
      ...(user.accessRoleId !== undefined ? { accessRoleId: user.accessRoleId } : {}),
      type: "access",
    },
    getSecret(),
    { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
  );
}

/**
 * Sign a long-lived refresh token (7 days).
 * Carries username/displayName/role so refresh doesn't need a Nextcloud
 * round-trip and the new access token preserves the user's identity.
 *
 * WARP-116: each refresh token carries a random `jti` so two tokens minted
 * for the same user in the same second (concurrent device logins; a login +
 * immediate rotation) are still byte-distinct. Distinct tokens → distinct
 * SHA-256 hashes, which the denylist and the per-user session index both key
 * on. Without the `jti`, two same-second sessions collapsed to one hash:
 * denylisting one would silently kill the other, and the session index could
 * only ever hold a single member per second. The claim is opaque to
 * `verifyRefreshToken` (it ignores unknown claims) — purely a uniqueness salt.
 */
export function signRefreshToken(user: {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  /** WARP-247 — session record id shared across the whole rotation lineage. */
  sid?: string;
}): string {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      ...(user.sid ? { sid: user.sid } : {}),
      type: "refresh",
      jti: randomUUID(),
    },
    getSecret(),
    { expiresIn: REFRESH_TOKEN_TTL_SECONDS },
  );
}

/**
 * Verify and decode an access token. Returns the payload or null.
 * Explicitly rejects refresh tokens (type check) to prevent confusion attacks.
 */
export function verifyAccessToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, getSecret()) as jwt.JwtPayload & Partial<JwtPayload> & {
      type?: string;
    };
    if (decoded.type !== "access") return null;
    if (!decoded.sub || !decoded.username || !decoded.role) return null;
    if (!VALID_ROLES.includes(decoded.role as Role)) return null;
    return {
      sub: decoded.sub,
      username: decoded.username,
      displayName: decoded.displayName ?? decoded.username,
      role: decoded.role as Role,
      ...(typeof decoded.lastMfaAt === "string"
        ? { lastMfaAt: decoded.lastMfaAt }
        : {}),
      ...(typeof decoded.sid === "string" ? { sid: decoded.sid } : {}),
      // WARP-1582 — surface the claim ONLY when it is well-formed: a
      // string, or an explicit null. Anything else (a number, an object,
      // a forged shape that survived signature verification because it
      // was minted by us before a refactor) degrades to ABSENT, which
      // routes the consumer back to the database. The fail-safe direction
      // is "unknown", never the one value that permits skipping a read.
      ...(typeof decoded.accessRoleId === "string" || decoded.accessRoleId === null
        ? { accessRoleId: decoded.accessRoleId }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Verify a refresh token. Returns the full user payload or null.
 * Also checks the Redis denylist for revoked/rotated tokens.
 *
 * A refresh token without a valid role claim is rejected outright to avoid
 * quiet privilege paths — there are no pre-existing refresh tokens in prod
 * that would need a fallback.
 */
export async function verifyRefreshToken(
  token: string,
): Promise<JwtPayload | null> {
  try {
    const decoded = jwt.verify(token, getSecret()) as jwt.JwtPayload & Partial<JwtPayload> & {
      type?: string;
    };
    if (decoded.type !== "refresh") return null;
    if (!decoded.sub || !decoded.username || !decoded.role) return null;
    if (!VALID_ROLES.includes(decoded.role as Role)) return null;

    // Check denylist (includes rotation lock)
    const denied = await cacheGet<boolean>(REFRESH_DENYLIST_PREFIX + tokenHash(token));
    if (denied) return null;

    return {
      sub: decoded.sub,
      username: decoded.username,
      displayName: decoded.displayName ?? decoded.username,
      role: decoded.role as Role,
      ...(typeof decoded.sid === "string" ? { sid: decoded.sid } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Add a refresh token to the Redis denylist.
 * TTL matches the token's remaining lifetime so the entry auto-expires.
 *
 * Uses jwt.verify (not jwt.decode) to reject unsigned or forged tokens,
 * preventing an attacker from crafting tokens with large exp values to
 * flood Redis with long-lived denylist entries.
 */
export async function denyRefreshToken(token: string): Promise<void> {
  try {
    const decoded = jwt.verify(token, getSecret()) as jwt.JwtPayload;
    if (!decoded?.exp) return;

    const ttl = decoded.exp - Math.floor(Date.now() / 1000);
    if (ttl <= 0) return; // Already expired — no need to denylist

    await cacheSet(REFRESH_DENYLIST_PREFIX + tokenHash(token), true, ttl);
  } catch {
    // Invalid signature or expired — safe to ignore; forged tokens need no denylist entry
  }
}

/**
 * Attempt to claim exclusive rotation rights for a refresh token.
 * Returns true if the caller won the race; false if another request is
 * already rotating this token.
 *
 * Prevents concurrent /auth/refresh calls (e.g. a browser double-submit on
 * flaky networks) from both issuing new token pairs.
 *
 * Implementation: a single atomic `SET key … NX EX 30` into the same denylist
 * namespace so subsequent `verifyRefreshToken` calls treat the token as
 * revoked. The atomic NX write is what makes the claim race-safe — a previous
 * non-atomic GET-then-SET let two concurrent /auth/refresh calls both observe
 * "absent" and both win, forking the token into two live session lineages
 * (ORCH-03). The caller that wins the claim should still call
 * `denyRefreshToken` to write the full-lifetime entry, ensuring the rotated
 * token stays revoked past this short TTL.
 *
 * Fails CLOSED: `cacheSetNx` returns false on any Redis error, so a Redis
 * outage rejects the rotation rather than allowing unbounded concurrent
 * rotation of the same token.
 */
export async function claimRefreshRotation(token: string): Promise<boolean> {
  const key = REFRESH_DENYLIST_PREFIX + tokenHash(token);
  // 30s is long enough to cover the in-flight refresh call; denyRefreshToken
  // will overwrite this with the full remaining token lifetime.
  return cacheSetNx(key, true, 30);
}

/**
 * WARP-116 — register a freshly-issued refresh token in the user's live
 * session set (`jwt:sessions:{userId}`). Called on login and on every refresh
 * rotation (for the NEW token). The member is `${tokenHash}:${exp}` so the
 * revoke path can recover each token's remaining TTL without ever storing the
 * raw token.
 *
 * Verifies the token first (rejects forged/expired) so a caller can't poison
 * the index with garbage members. Non-fatal on any failure — the session
 * index is an optimization that makes "revoke now" possible; a missed write
 * just means that one session falls back to its own ≤7-day TTL.
 */
export async function registerRefreshSession(
  userId: string,
  token: string,
): Promise<void> {
  try {
    const decoded = jwt.verify(token, getSecret()) as jwt.JwtPayload & {
      type?: string;
    };
    if (decoded.type !== "refresh" || !decoded.exp) return;
    const ttl = decoded.exp - Math.floor(Date.now() / 1000);
    if (ttl <= 0) return;
    const member = `${tokenHash(token)}:${decoded.exp}`;
    await cacheSetAdd(SESSION_SET_PREFIX + userId, member, ttl);
  } catch {
    // Invalid signature / expired — nothing to index.
  }
}

/**
 * WARP-116 — drop a single refresh token's member from the user's session set
 * (logout, or the old token after a refresh rotation). Best-effort: the
 * denylist is the authoritative revoke; this just keeps the index tidy so a
 * later `revokeUserSessions` doesn't re-denylist an already-dead token.
 */
export async function unregisterRefreshSession(
  userId: string,
  token: string,
): Promise<void> {
  try {
    const decoded = jwt.verify(token, getSecret()) as jwt.JwtPayload & {
      type?: string;
    };
    if (decoded.type !== "refresh" || !decoded.exp) return;
    const member = `${tokenHash(token)}:${decoded.exp}`;
    await cacheSetRemove(SESSION_SET_PREFIX + userId, member);
  } catch {
    // Forged/expired token — nothing indexed under it.
  }
}

/**
 * WARP-116 — immediately revoke every live refresh-token session for a user.
 * Reads the session set, adds each member's token hash to the denylist with
 * that token's REMAINING TTL (so the denylist entry can't outlive the token
 * it shadows, and an already-expired member is skipped), then clears the set.
 *
 * Returns the number of tokens denylisted. Used by the admin
 * revoke-sessions endpoint and wired into the role-change / user-disable
 * flows so a permission change propagates on the next refresh instead of
 * waiting out the ≤15-min access-token TTL.
 *
 * Note: this revokes REFRESH tokens only. Already-issued access tokens stay
 * valid until their ≤15-min expiry by design (stateless verification) — the
 * revoke bites the moment the client tries to refresh.
 *
 * KNOWN RACE (revoke-after-clear TOCTOU, follow-up ticket): a concurrent
 * /auth/refresh that wins its rotation claim and SADDs the NEW token member
 * AFTER this function's SMEMBERS+cacheDel has run will survive the revoke — its
 * member was never read, so it's neither denylisted nor cleared. A full fix
 * needs a per-user revoked-at fence (or a post-claim denylist re-check in the
 * refresh path) and is deliberately out of scope here. The privilege impact is
 * mitigated by the refresh path re-deriving the role from the authoritative DB
 * row on every rotation (auth.ts, review fix 1): even a surviving session can
 * only ever mint the user's CURRENT role, not a stale higher one.
 */
export async function revokeUserSessions(userId: string): Promise<number> {
  const setKey = SESSION_SET_PREFIX + userId;
  const members = await cacheSetMembers(setKey);
  const now = Math.floor(Date.now() / 1000);
  let revoked = 0;
  for (const member of members) {
    // Member shape is `${hash}:${exp}`; the hash is hex (no colon) so split on
    // the LAST colon to tolerate any future prefix change without corrupting
    // the hash.
    const sep = member.lastIndexOf(":");
    if (sep <= 0) continue;
    const hash = member.slice(0, sep);
    const exp = Number(member.slice(sep + 1));
    if (!Number.isFinite(exp)) continue;
    const ttl = exp - now;
    if (ttl <= 0) continue; // Already expired — denylist entry would be a no-op.
    await cacheSet(REFRESH_DENYLIST_PREFIX + hash, true, ttl);
    revoked += 1;
  }
  // Clear the index whether or not anything was denylisted: leaving stale
  // (now-denylisted or expired) members would let a later revoke re-walk dead
  // hashes and would leak the index unbounded.
  await cacheDel(setKey);
  return revoked;
}

/**
 * Deterministic hash of a token for denylist keys (avoids storing raw tokens in Redis).
 * Full SHA-256 output (64 hex chars) — no truncation.
 */
function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
