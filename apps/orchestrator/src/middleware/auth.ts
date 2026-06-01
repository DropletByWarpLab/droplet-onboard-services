import { Request, Response, NextFunction } from "express";
import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import pino from "pino";
import { config } from "../config.js";
import { cacheGet, cacheSet } from "../services/cache.service.js";
import { verifyAccessToken, roleFromGroups, type Role } from "../services/jwt.service.js";

const logger = pino({ name: "auth" });

/**
 * WARP-485 — process-wide Prisma reference used by the OCS fallback to
 * look up the local `User` row that matches the Nextcloud user id. Set
 * once at app boot via `setAuthPrisma(prisma)`; null before boot or in
 * tests that don't wire one. Mirrors the `activity.singleton.ts`
 * pattern so the orchestrator's existing app-construction order
 * doesn't need a refactor.
 *
 * Kept in module scope (rather than threaded through `authMiddleware`
 * as a closure) so the dozens of `app.use(authMiddleware)` callsites
 * — including the tests that mount the production middleware directly —
 * don't all need to pass a prisma client. The fail-closed branch in
 * `validateNextcloudToken` covers the "not yet initialised" case so a
 * pre-boot request can never sneak past with an un-normalized id.
 */
let authPrisma: PrismaClient | null = null;

/**
 * Wire the Prisma client used by the OCS fallback to resolve
 * `nextcloudUsername → User.id`. Called once at app boot from
 * `createApp(prisma)`. Idempotent — subsequent calls overwrite the
 * binding, which is what tests want when they reset between cases.
 */
export function setAuthPrisma(prisma: PrismaClient): void {
  authPrisma = prisma;
}

/** Test-only handle — exported so vitest can reset between cases. */
export function _setAuthPrismaForTests(prisma: PrismaClient | null): void {
  authPrisma = prisma;
}

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
    // PR #372: first-run setup state machine. GET/PATCH must be reachable
    // before any user exists (resumable wizard), same posture as
    // /api/auth/setup above.
    "/api/setup/state",
    // PR #373: onboarding CLAIM step. The hardware contract
    // (GET /api/setup/appliance) and the claim verify (POST /api/setup/claim)
    // run BEFORE any account exists (welcome → claim → account), so they share
    // the same public posture. Exact paths — NOT a "/api/setup/" prefix —
    // so no future /api/setup/* route is silently de-authed. The claim
    // endpoint enforces its own per-IP rate limit in routes/setup.ts.
    "/api/setup/appliance",
    "/api/setup/claim",
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
      // PR #375 — carry the MFA-challenge timestamp through so
      // require-recent-mfa can gate sensitive routes (WARP-230).
      lastMfaAt: jwtPayload.lastMfaAt ?? null,
    };
    next();
    return;
  }

  // Fallback: validate against Nextcloud OCS (legacy tokens)
  validateNextcloudTokenDetailed(token)
    .then((result) => {
      if (result.kind === "ok") {
        req.user = result.user;
        next();
        return;
      }
      if (cookieToken) {
        res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      }
      // WARP-485 — surface a distinct structured error for "OCS token
      // is valid, but no local User row maps to it" so the dashboard
      // can prompt the operator to add the user via /api/people
      // instead of treating it as a generic auth failure. Same 401
      // status code (no privilege change) — just a code field clients
      // can branch on.
      if (result.kind === "user-not-provisioned") {
        res.status(401).json({
          error:
            "User not provisioned. Ask an owner to add this account via /api/people.",
          code: "USER_NOT_PROVISIONED",
        });
        return;
      }
      res.status(401).json({ error: "Invalid or expired token" });
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
 * WARP-485 — discriminated return so the middleware can distinguish
 * "OCS token is valid but no local User row maps to it" (the fail-
 * closed branch) from "OCS rejected the token outright". Same 401
 * status either way; clients (and tests) branch on the `code` field
 * we render in the response body.
 */
type OcsValidationResult =
  | { kind: "ok"; user: AuthUser }
  | { kind: "invalid" } // OCS rejected the token (bad creds, meta.status !== ok, network fail)
  | { kind: "user-not-provisioned" }; // OCS accepted, no matching local User row

/**
 * Validate a token against Nextcloud OCS API with Redis cache.
 * Returns a user with default "family" role (Nextcloud doesn't have role claims).
 *
 * WARP-485 — `req.user.id` shape contract across the JWT vs OCS paths:
 *
 *   • JWT path (`verifyAccessToken` above): `req.user.id = jwtPayload.sub`,
 *     which is the local `User.id` UUID. This is the source of truth.
 *
 *   • OCS path (this function, pre-WARP-485): `req.user.id = ocs.data.id`,
 *     which is the **Nextcloud username string** (e.g. `stefan-cruceru`),
 *     NOT a UUID. That mismatch silently broke WARP-480's self-action guard
 *     (`req.params.id === req.user?.id` on /api/people/:id mutations) under
 *     OCS auth — the comparison always returned false-negative, so an owner
 *     authenticated via the OCS fallback could DELETE themselves and lock
 *     the household out of every owner-only route.
 *
 *   • OCS path (WARP-485 fix): lookup `User` by `nextcloudUsername`, set
 *     `req.user.id = localUser.id`. Fail-closed with 401 `USER_NOT_PROVISIONED`
 *     when no matching User row exists — silent auto-provision would be a
 *     privilege-escalation vector (an attacker who somehow holds a valid
 *     OCS token for an unrelated NC user could otherwise mint a local row).
 *     `req.user.username` keeps the Nextcloud username for display, and
 *     `req.user.role` is still derived from OCS groups via `roleFromGroups`
 *     (the JWT path's role takes precedence when a JWT is present).
 *
 * Downstream invariant: every `req.user.id` consumer (people self-action
 * guard, camera pins, /auth/me, brain-memory ownership checks, etc.) may
 * assume the value is a local User UUID regardless of auth path.
 */
async function validateNextcloudTokenDetailed(
  token: string,
): Promise<OcsValidationResult> {
  const cacheKey = TOKEN_CACHE_PREFIX + hashToken(token);

  // The Redis cache stores fully-normalised AuthUser rows (already
  // post-WARP-485 lookup). On hit we still return { kind: "ok", user }
  // so the discriminator stays consistent end-to-end.
  const cached = await cacheGet<AuthUser>(cacheKey);
  if (cached) return { kind: "ok", user: cached };

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

    if (!resp.ok) return { kind: "invalid" };

    const data = await resp.json();
    const ocs = data?.ocs;
    if (ocs?.meta?.status !== "ok") return { kind: "invalid" };

    const groups: string[] = ocs.data.groups || [];
    const ncUsername: string = ocs.data.id;

    // WARP-485 — normalize req.user.id to the local User.id UUID so
    // downstream consumers (people self-action guard, camera pins,
    // /auth/me, etc.) get the same shape regardless of which path
    // populated the session. Fail-closed when prisma isn't wired or
    // when no local row matches — silent auto-provision would be a
    // privilege-escalation vector (an attacker holding a valid OCS
    // token for an unrelated NC user could otherwise mint a local
    // row with the default `family` role).
    if (!authPrisma) {
      logger.warn(
        { ncUsername },
        "OCS auth: Prisma not initialised; refusing to populate req.user (WARP-485 fail-closed)",
      );
      return { kind: "user-not-provisioned" };
    }
    const localUser = await authPrisma.user.findUnique({
      where: { nextcloudUsername: ncUsername },
    });
    if (!localUser) {
      logger.warn(
        { ncUsername },
        "OCS auth: no local User row for Nextcloud user; operator must provision via /api/people",
      );
      return { kind: "user-not-provisioned" };
    }

    const user: AuthUser = {
      id: localUser.id,
      username: ncUsername,
      displayName: ocs.data["display-name"] || ncUsername,
      role: roleFromGroups(groups),
    };

    await cacheSet(cacheKey, user, TOKEN_CACHE_TTL);
    return { kind: "ok", user };
  } catch (err) {
    logger.warn({ err }, "Failed to reach Nextcloud for token validation");
    return { kind: "invalid" };
  }
}

/**
 * Validate a Nextcloud OCS token and return the normalized AuthUser,
 * or null if the token is invalid OR the OCS user has no matching
 * local User row. Thin wrapper around `validateNextcloudTokenDetailed`
 * for the WebSocket-upgrade path (which has no way to surface a
 * structured error code — it just rejects the upgrade).
 */
async function validateNextcloudToken(
  token: string,
): Promise<AuthUser | null> {
  const result = await validateNextcloudTokenDetailed(token);
  return result.kind === "ok" ? result.user : null;
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
  {
    // WARP-339: mcp-server presents this Bearer on outbound calls to
    // the orchestrator's REST routes (matter, audit-log, safety-tier).
    // See services/mcp-server/src/index.ts createHttpClient("orchestrator").
    token: config.SERVICE_TOKEN_MCP,
    principal: {
      id: "_service:mcp",
      username: "_service:mcp",
      displayName: "MCP Server",
      role: "service",
    },
  },
  {
    // WARP-465: email-indexer presents this Bearer on ingest POSTs to
    // /api/email/_ingest/* and PATCH /api/email/_ingest/drafts/:id.
    // The Python client sends it as `ORCHESTRATOR_SERVICE_TOKEN`; the
    // orchestrator stores it as SERVICE_TOKEN_EMAIL — compose wires
    // both ends to the same `secrets.sh`-generated value.
    token: config.SERVICE_TOKEN_EMAIL,
    principal: {
      id: "_service:email",
      username: "_service:email",
      displayName: "Email Indexer",
      role: "service",
    },
  },
  {
    // WARP-468: routing service's egress_meter.py presents this Bearer
    // on POST /api/network/off-lan-sample-batch. WARP-470: routing's
    // scheduler.py presents the same shared token on POST
    // /api/network/throughput-sample. Both samplers run under
    // network_mode: host so service-name DNS doesn't resolve — the
    // sampler hits the orchestrator on localhost:3000 with this bearer.
    token: config.ORCHESTRATOR_SAMPLER_TOKEN,
    principal: {
      id: "_service:sampler",
      username: "_service:sampler",
      displayName: "Routing Sampler",
      role: "service",
    },
  },
  {
    // WARP-468: ai-gateway's off_lan_gating middleware presents this
    // Bearer on GET /api/network/off-lan and /api/settings/off-lan
    // to read the cloud_model_escape posture before allowing a
    // cloud-model call. Without this, the gate fails closed and every
    // cloud LLM request 451s regardless of operator configuration.
    token: config.AI_GATEWAY_SAMPLER_TOKEN,
    principal: {
      id: "_service:ai-gateway",
      username: "_service:ai-gateway",
      displayName: "AI Gateway Sampler",
      role: "service",
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

/**
 * WARP-171: per-route RBAC guard. Mounts after `authMiddleware`; assumes
 * `req.user.role` is populated by the upstream middleware (either from
 * a verified JWT, a matched service principal, or the Nextcloud OCS
 * fallback). Returns 403 — NOT 401 — when:
 *
 *   - `req.user` is absent (defense in depth; the upstream middleware
 *     should have already issued 401, but a misordered router would
 *     otherwise allow the request through silently),
 *   - `req.user.role` is missing or not a string,
 *   - the role is not in the `allowed` list (including the empty-list
 *     programmer-error case — no implicit allow-all).
 *
 * The 401-vs-403 distinction matters: 401 means "tell me who you are";
 * 403 means "I know who you are, just not allowed". Conflating them
 * leaks the auth-vs-authz ordering to clients and breaks the
 * dashboard's two-stage error rendering (toast vs redirect-to-login).
 *
 * Usage:
 *   router.post("/auth/users", requireRole("owner", "admin"), handler);
 *
 * See `docs/ADR-004-rbac-per-route-guards.md` §3 for the per-route
 * allowlist matrix. Each guarded route file derives its allowed roles
 * from that matrix; the matrix is mirrored in tests
 * (`src/__tests__/rbac.test.ts`) so additions stay in sync.
 */
export function requireRole(
  ...allowed: Role[]
): (req: Request, res: Response, next: NextFunction) => void {
  // Cache the allowed set so the per-request hot path is just one
  // string lookup. The middleware is constructed once per route and
  // invoked thousands of times; the Set avoids a linear scan when
  // a route allows multiple roles.
  const allowedSet = new Set<string>(allowed);
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = req.user?.role;
    if (typeof role !== "string" || role.length === 0) {
      res.status(403).json({ error: "Forbidden: no role on session" });
      return;
    }
    if (!allowedSet.has(role)) {
      res.status(403).json({ error: "Forbidden: role not permitted" });
      return;
    }
    next();
  };
}
