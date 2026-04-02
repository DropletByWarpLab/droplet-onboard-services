import { Request, Response, NextFunction } from "express";
import { createHash } from "node:crypto";
import pino from "pino";
import { config } from "../config.js";
import { cacheGet, cacheSet } from "../services/cache.service.js";

const logger = pino({ name: "auth" });

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
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

// ── Cookie configuration ──
export const SESSION_COOKIE_NAME = "droplet_session";
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Auth middleware that validates tokens against Nextcloud's OCS API.
 *
 * Token resolution order:
 *   1. `droplet_session` HTTP-only cookie  (browser sessions)
 *   2. `Authorization: Bearer <token>`     (API clients)
 *
 * Controlled by AUTH_ENABLED env var — when false, all requests pass through.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!config.AUTH_ENABLED) {
    // Auth disabled — set a default dev user and continue
    req.user = { id: "dev", username: "dev", displayName: "Developer" };
    next();
    return;
  }

  // Skip auth for public endpoints
  const publicPaths = ["/api/health", "/api/auth/setup", "/api/auth/login"];
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

  validateToken(token)
    .then((user) => {
      if (!user) {
        // Clear stale cookie if present
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
 * Validate a token by checking Redis cache first, then querying Nextcloud.
 */
async function validateToken(token: string): Promise<AuthUser | null> {
  const cacheKey = TOKEN_CACHE_PREFIX + hashToken(token);

  // Check cache first
  const cached = await cacheGet<AuthUser>(cacheKey);
  if (cached) return cached;

  // Validate against Nextcloud OCS API
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
    });

    if (!resp.ok) return null;

    const data = await resp.json();
    const ocs = data?.ocs;
    if (ocs?.meta?.status !== "ok") return null;

    const user: AuthUser = {
      id: ocs.data.id,
      username: ocs.data.id,
      displayName: ocs.data["display-name"] || ocs.data.id,
    };

    // Cache the validated user
    await cacheSet(cacheKey, user, TOKEN_CACHE_TTL);
    return user;
  } catch (err) {
    logger.warn({ err }, "Failed to reach Nextcloud for token validation");
    return null;
  }
}

function hashToken(token: string): string {
  // SHA-256 truncated to 16 hex chars — collision-resistant cache key
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}
