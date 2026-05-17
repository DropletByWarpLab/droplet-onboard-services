import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { cacheGet, cacheSet } from "./cache.service.js";

export type Role = "owner" | "admin" | "family" | "guest" | "service";

export interface JwtPayload {
  sub: string;
  username: string;
  displayName: string;
  role: Role;
}

// Single source of truth for token lifetimes. Both the jwt `expiresIn` option
// and the cookie `maxAge` derive from these — keep them in sync here only.
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

const REFRESH_DENYLIST_PREFIX = "jwt:deny:";
const REFRESH_LOCK_PREFIX = "jwt:rotate:";

const VALID_ROLES: readonly Role[] = ["owner", "admin", "family", "guest", "service"] as const;

/**
 * Derive a role from a Nextcloud group list.
 * Single source of truth — used at login and in the Nextcloud OCS fallback.
 *
 * TODO(Phase 3 / M2.2): Expand to cover the full four-role system.
 * Today only `admin` group → `owner` and everything else → `family` is wired;
 * `admin` and `guest` roles exist in the type but have no group mapping yet.
 */
export function roleFromGroups(groups: string[]): Role {
  if (groups.includes("admin")) return "owner";
  return "family";
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
}): string {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
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
 */
export function signRefreshToken(user: {
  id: string;
  username: string;
  displayName: string;
  role: Role;
}): string {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      type: "refresh",
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
 * Implementation: writes a short-TTL entry into the same denylist namespace
 * so subsequent `verifyRefreshToken` calls treat the token as revoked. The
 * caller that wins the claim should still call `denyRefreshToken` to write
 * the full-lifetime entry, ensuring the rotated token stays revoked past
 * this short TTL.
 */
export async function claimRefreshRotation(token: string): Promise<boolean> {
  const key = REFRESH_DENYLIST_PREFIX + tokenHash(token);
  const existing = await cacheGet<boolean>(key);
  if (existing) return false;
  // 30s is long enough to cover the in-flight refresh call; denyRefreshToken
  // will overwrite this with the full remaining token lifetime.
  await cacheSet(key, true, 30);
  return true;
}

/**
 * Deterministic hash of a token for denylist keys (avoids storing raw tokens in Redis).
 * Full SHA-256 output (64 hex chars) — no truncation.
 */
function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
