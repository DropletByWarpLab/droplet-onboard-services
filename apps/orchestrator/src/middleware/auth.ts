import { Request, Response, NextFunction } from "express";
import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import pino from "pino";
import { config } from "../config.js";
import { cacheGet, cacheSet } from "../services/cache.service.js";
import { verifyAccessToken, roleFromGroups, type Role } from "../services/jwt.service.js";

const logger = pino({ name: "auth" });

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  /**
   * WARP-230: timestamp of the most-recent successful MFA challenge.
   * Read by `require-recent-mfa` middleware to gate sensitive admin
   * actions (device-identity reseal, future key rotation). Populated
   * by the MFA-challenge flow in WARP-238; until that ticket lands
   * this is always null and reseal routes will 401 mfa_required,
   * which is the correct fail-closed behavior.
   */
  lastMfaAt?: Date | string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const TOKEN_CACHE_PREFIX = "auth:token:";
const TOKEN_CACHE_TTL = 300; // 5 minutes
/**
 * WARP-303: bound the Nextcloud OCS validation fetch. On a Redis cache miss
 * (every 5 min idle, or after a restart), this fetch is the only thing
 * standing between the request and the route handler — and Nextcloud
 * occasionally takes long enough to hang the middleware indefinitely,
 * which surfaced to users as intermittent 401s on `/api/llm/models`. 5 s is
 * generous for an OCS user lookup; on timeout we fail closed (treat the
 * token as invalid) so the client retries or re-auths cleanly.
 */
const OCS_VALIDATION_TIMEOUT_MS = 5_000;

// ── Cookie configuration ──
// Cookie max-ages derive from the TTL constants in jwt.service (single source
// of truth). Import `ACCESS_TOKEN_TTL_SECONDS` / `REFRESH_TOKEN_TTL_SECONDS`
// there and multiply by 1000.
export const SESSION_COOKIE_NAME = "droplet_session";
export const REFRESH_COOKIE_NAME = "droplet_refresh";

/**
 * Auth middleware — validates JWT access tokens, with Nextcloud OCS fallback.
 *
 * Token resolution order:
 *   1. `Authorization: Bearer <jwt>`        (API clients — JWT preferred)
 *   2. `droplet_session` HTTP-only cookie   (browser sessions — JWT or legacy Nextcloud token)
 *
 * JWT tokens are self-verifying (no Redis/Nextcloud call needed).
 * Legacy Nextcloud tokens fall through to OCS validation with Redis cache.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!config.AUTH_ENABLED) {
    req.user = { id: "dev", username: "dev", displayName: "Developer", role: "owner" };
    next();
    return;
  }

  // Skip auth for public endpoints
  const publicPaths = [
    "/api/health",
    "/api/orchestrator/health",
    "/api/auth/setup",
    "/api/auth/login",
    "/api/auth/authorize",
    "/api/auth/callback",
    "/api/auth/refresh",
    // WARP-217: invite-accept must be reachable by a fully logged-out
    // invitee. The token in the URL is the auth.
    "/api/auth/invites/accept/",
  ];
  if (publicPaths.some((p) => req.path === p || req.path.startsWith(p))) {
    next();
    return;
  }

  // Resolve token: cookie first, then Authorization header
  const cookieToken = req.cookies?.[SESSION_COOKIE_NAME];
  const authHeader = req.headers.authorization;
  const headerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const token = cookieToken || headerToken;

  if (!token) {
    res.status(401).json({ error: "Missing or invalid authentication" });
    return;
  }

  // Service principal first — fixed-string Bearer match against configured
  // SERVICE_TOKEN_VOICE (and any future SERVICE_TOKEN_* additions). Constant-
  // time string compare via `timingSafeEqual` so a token-guessing attacker
  // can't time-slice their way to a match. Service principals get the
  // `service` role; downstream RBAC (narrowAllowedToolsForRole, MCP tool
  // surface) treats them as unprivileged — read tools only, no writes.
  // Only header tokens are eligible — cookies are for human sessions.
  if (headerToken) {
    const servicePrincipal = matchServiceToken(headerToken);
    if (servicePrincipal) {
      req.user = servicePrincipal;
      next();
      return;
    }
  }

  // Try JWT first — self-verifying, no network call
  const jwtPayload = verifyAccessToken(token);
  if (jwtPayload) {
    req.user = {
      id: jwtPayload.sub,
      username: jwtPayload.username,
      displayName: jwtPayload.displayName,
      role: jwtPayload.role,
    };
    next();
    return;
  }

  // Fallback: validate against Nextcloud OCS (legacy tokens)
  validateNextcloudToken(token)
    .then((user) => {
      if (!user) {
        if (cookieToken) {
          res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
        }
        res.status(401).json({ error: "Invalid or expired token" });
        return;
      }
      req.user = user;
      next();
    })
    .catch((err) => {
      logger.error({ err }, "Token validation failed");
      res.status(500).json({ error: "Authentication service error" });
    });
}

/**
 * Validate a session token outside the Express pipeline (WebSocket upgrade).
 */
export async function validateTokenForWs(token: string | null): Promise<AuthUser | null> {
  if (!config.AUTH_ENABLED) {
    return { id: "dev", username: "dev", displayName: "Developer", role: "owner" };
  }
  if (!token) return null;

  // Try JWT first
  const jwtPayload = verifyAccessToken(token);
  if (jwtPayload) {
    return {
      id: jwtPayload.sub,
      username: jwtPayload.username,
      displayName: jwtPayload.displayName,
      role: jwtPayload.role,
    };
  }

  // Fallback to Nextcloud
  return validateNextcloudToken(token);
}

/**
 * Validate a token against Nextcloud OCS API with Redis cache.
 * Returns a user with default "family" role (Nextcloud doesn't have role claims).
 */
async function validateNextcloudToken(token: string): Promise<AuthUser | null> {
  const cacheKey = TOKEN_CACHE_PREFIX + hashToken(token);

  const cached = await cacheGet<AuthUser>(cacheKey);
  if (cached) return cached;

  try {
    const url = `${config.NEXTCLOUD_URL}/ocs/v1.php/cloud/user`;
    const authHeaderValue = token.startsWith("basic:")
      ? `Basic ${token.slice(6)}`
      : `Bearer ${token}`;
    const resp = await fetch(url, {
      headers: {
        Authorization: authHeaderValue,
        "OCS-APIRequest": "true",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(OCS_VALIDATION_TIMEOUT_MS),
    });

    if (!resp.ok) return null;

    const data = await resp.json();
    const ocs = data?.ocs;
    if (ocs?.meta?.status !== "ok") return null;

    const groups: string[] = ocs.data.groups || [];
    const user: AuthUser = {
      id: ocs.data.id,
      username: ocs.data.id,
      displayName: ocs.data["display-name"] || ocs.data.id,
      role: roleFromGroups(groups),
    };

    await cacheSet(cacheKey, user, TOKEN_CACHE_TTL);
    return user;
  } catch (err) {
    logger.warn({ err }, "Failed to reach Nextcloud for token validation");
    return null;
  }
}

function hashToken(token: string): string {
  // Full SHA-256 output — a truncated hash would allow cache collisions that
  // could return the wrong user's identity (serious auth bypass).
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Service-principal bearer tokens. Registry of `(envVarValue → AuthUser)`
 * pairs, built once at module load. Empty token values are excluded so a
 * misconfigured deployment can't accidentally accept an empty Bearer.
 *
 * To register a new service principal: add the env var to `config.ts` under
 * "Service-principal bearer tokens", then push an entry below.
 */
interface ServicePrincipalDef {
  /** The configured shared-secret value, e.g. `config.SERVICE_TOKEN_VOICE`. */
  token: string;
  /** The principal returned to req.user on match. */
  principal: AuthUser;
}

const SERVICE_PRINCIPALS: readonly ServicePrincipalDef[] = [
  {
    token: config.SERVICE_TOKEN_VOICE,
    principal: {
      id: "_service:voice",
      username: "_service:voice",
      displayName: "Voice Assistant",
      role: "service",
    },
  },
  // WARP-399 — ops-console approval surface. Distinct from voice in that
  // ops needs ADMIN role to POST /api/autonomous-proposals/:id/approve|reject
  // (which gates on owner/admin). The trust boundary here is the
  // Warp Lab operator behind ops-console, NOT the customer-facing
  // dashboard surface — different audit semantics (ops surfaces this
  // as `_service:ops`, not as a real user) but same effective rights
  // on the autonomous-proposals routes.
  {
    token: config.SERVICE_TOKEN_OPS,
    principal: {
      id: "_service:ops",
      username: "_service:ops",
      displayName: "Ops Console",
      role: "admin",
    },
  },
];

function matchServiceToken(token: string): AuthUser | null {
  const candidate = Buffer.from(token, "utf8");
  for (const def of SERVICE_PRINCIPALS) {
    if (!def.token) continue;
    const expected = Buffer.from(def.token, "utf8");
    if (candidate.length !== expected.length) continue;
    if (timingSafeEqual(candidate, expected)) return def.principal;
  }
  return null;
}
