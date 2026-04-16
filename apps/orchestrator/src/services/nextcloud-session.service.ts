import type { Request } from "express";
import { getRedis } from "./cache.service.js";
import { verifyAccessToken } from "./jwt.service.js";
import { SESSION_COOKIE_NAME } from "../middleware/auth.js";

/**
 * Redis-backed store for per-user Nextcloud app-password tokens.
 *
 * After JWT auth was introduced, the browser's session cookie carries a JWT
 * rather than a Nextcloud token. File/storage/user-admin routes still need
 * to impersonate the caller against Nextcloud (WebDAV + OCS), so we stash
 * the Nextcloud token server-side at login time and look it up by user id
 * on every downstream request.
 *
 * Trade-off: storing the app-password in Redis means a single Redis breach
 * exposes Nextcloud credentials. The alternative — using a shared admin
 * token — is worse (single point of failure, can't audit per-user actions).
 * We mitigate by (1) scoping the TTL to the refresh-token lifetime, (2)
 * revoking at logout, and (3) requiring Redis to be password-protected.
 */

const NC_TOKEN_PREFIX = "auth:nc-token:";

/**
 * Persist a Nextcloud app-password for the given user id.
 * Subsequent lookups by the same user id overwrite the entry, so a fresh
 * login always replaces any stale token.
 */
export async function storeNcToken(
  userId: string,
  token: string,
  ttlSeconds: number
): Promise<void> {
  await getRedis().set(NC_TOKEN_PREFIX + userId, token, "EX", ttlSeconds);
}

/**
 * Fetch the Nextcloud app-password previously stored for this user id.
 * Returns null if none is stored (e.g. the session pre-dates this change,
 * or the TTL expired) — callers should treat that as an auth failure and
 * prompt re-login rather than silently 500.
 */
export async function getNcToken(userId: string): Promise<string | null> {
  try {
    return await getRedis().get(NC_TOKEN_PREFIX + userId);
  } catch {
    return null;
  }
}

/**
 * Remove the stored token for this user (called on logout). Non-fatal if
 * the entry is already gone.
 */
export async function deleteNcToken(userId: string): Promise<void> {
  try {
    await getRedis().del(NC_TOKEN_PREFIX + userId);
  } catch {
    // Cleanup failures are non-fatal — the entry expires on its own
  }
}

/**
 * Extend the TTL on an existing entry without reissuing the token.
 * Used on refresh so the NC token lives as long as the active session,
 * rather than expiring mid-session and forcing a re-login for file ops.
 */
export async function touchNcToken(userId: string, ttlSeconds: number): Promise<void> {
  try {
    await getRedis().expire(NC_TOKEN_PREFIX + userId, ttlSeconds);
  } catch {
    // Non-fatal — worst case the user logs in again when the token expires
  }
}

/** Extract the raw session token from cookie or Authorization header. */
function extractSessionToken(req: Request): string | null {
  const cookieToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (cookieToken) return cookieToken;
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return null;
}

/**
 * Resolve the Nextcloud credential that should be used for an outbound OCS
 * or WebDAV call on behalf of the request's authenticated user.
 *
 * Resolution order:
 *   1. If the session token is a JWT (post-PR#12 browsers), look up the
 *      per-user Nextcloud app-password from Redis by `req.user.id`.
 *   2. Otherwise, treat the session token as a legacy Nextcloud token and
 *      forward it unchanged.
 *   3. Dev-mode fallback: when `AUTH_ENABLED=false` the middleware injects
 *      a synthetic `req.user` without issuing a cookie — return a non-empty
 *      placeholder so unit tests (which mock the Nextcloud client anyway)
 *      exercise the route instead of short-circuiting on 401.
 *
 * Returns `null` in production when neither path resolves — callers should
 * surface 401 so the dashboard prompts a fresh login, which re-seeds Redis.
 */
export async function resolveNcToken(req: Request): Promise<string | null> {
  const sessionToken = extractSessionToken(req);

  if (sessionToken) {
    // JWT path: session cookie holds a short-lived access token; the real
    // Nextcloud credential lives in Redis keyed by user id.
    if (verifyAccessToken(sessionToken)) {
      if (!req.user?.id) return null;
      return await getNcToken(req.user.id);
    }
    // Legacy path: session cookie IS the Nextcloud token (pre-JWT sessions
    // or OAuth2 access tokens from /auth/callback).
    return sessionToken;
  }

  // Dev / test path: no cookie but the auth middleware synthesized a user
  // (AUTH_ENABLED=false). Let the request through with a placeholder token
  // — the NC client is mocked in tests and won't dial a real server.
  if (req.user?.id === "dev") return "dev-mode-token";

  return null;
}
