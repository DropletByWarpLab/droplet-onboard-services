import { Request, Response, NextFunction } from "express";
import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { cacheGet, cacheSet, cacheDel } from "../services/cache.service.js";
import { verifyAccessToken, roleFromGroups, type Role } from "../services/jwt.service.js";
import { checkSession } from "../services/session.service.js";
import { isUserDenied } from "../services/auth-denylist.service.js";
import { createLogger } from "../lib/logger.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";

const logger = createLogger("auth");

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
  /** WARP-247 — session record id from the JWT's sid claim. Undefined for
   *  legacy tokens, service principals, and the OCS fallback path. */
  sid?: string;
  /**
   * WARP-1582 — the JWT's `accessRoleId` claim, verbatim and three-state:
   * `undefined` = the token carries none (legacy token, service principal,
   * the OCS fallback, or AUTH_ENABLED=false), `null` = "no custom access
   * role", a string = the assigned role's id.
   *
   * `undefined` and `null` are NOT interchangeable here. Consumers must
   * treat `undefined` as "unknown, go read the database" — see the trust
   * argument in services/tool-access.service.ts.
   */
  accessRoleId?: string | null;
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
    // PR #380: onboarding ORG step. POST /api/setup/org names the single
    // workspace + reserves droplet.local/<slug>. Org slots AFTER account, but
    // it shares the wizard's public posture so a refresh mid-org (before the
    // freshly-created session cookie is durably established) can still persist
    // instead of 401-ing the owner out of their own setup. Exact path — NOT a
    // "/api/setup/" prefix — so no future /api/setup/* route is silently
    // de-authed. The handler validates slug shape + uniqueness in
    // routes/setup.ts; it persists locally only (nothing off-box).
    "/api/setup/org",
    // WARP-979: onboarding SECURED / name-your-box step. The name check
    // (GET /api/setup/box-name/check) and the persist (POST /api/setup/box-name)
    // run during first-run onboarding (the account session cookie may not be
    // durably established yet mid-wizard), so they share the wizard's public
    // posture — exactly like /api/setup/org. The POST re-gates itself in
    // routes/setup.ts (session cookie OR appliance not-yet-ready) so a claimed
    // box can't be silently renamed by an anonymous LAN client; the GET is a
    // read-only, side-effect-free validity check.
    //
    // NOTE: the box-name routes need PREFIX semantics (/box-name covers
    // /box-name/check AND /box-name/rename), so they live in PUBLIC_PREFIXES
    // below — NOT this exact-match list. Their handlers re-gate themselves in
    // routes/setup.ts (owner/admin once the box is claimed; see ORCH-002).
    "/api/auth/login",
    "/api/auth/authorize",
    "/api/auth/callback",
    "/api/auth/refresh",
    // WARP-217: invite-accept (token-in-path) also needs prefix semantics —
    // see PUBLIC_PREFIXES below.
    // WARP-1474 (ADR-030/031): the dashboard-QR overlay REDEEM. The QR-scanning
    // phone has NO bearer by design, so this EXACT POST path must reach the
    // handler. Exact-match — NOT a prefix (SEND-BACK #4): the old
    // startsWith("…/by-token") prefix would fail OPEN for any future sibling
    // like `…/by-token-admin`. The `/status` subpath is opened separately by a
    // TRAILING-SLASH prefix in PUBLIC_PREFIXES below, so ONLY the exact redeem
    // path and the `…/by-token/<id>/status` tree are public; every sibling is
    // authed. The handler re-gates itself (one-time token consume, per-IP/
    // per-token/global rate limits, P256/WireGuard boundary validation).
    "/api/vpn/overlay/devices/by-token",
  ];
  // Exact-match the allowlist. Only two entries genuinely need PREFIX
  // semantics: the box-name pair (/api/setup/box-name covers /box-name/check
  // and /box-name/rename) and invite-accept (token-in-path). Everything else
  // is matched exactly, so a future /api/setup/<x> sibling can never be
  // silently de-authed by a stray prefix match (the latent fail-open ORCH-001
  // caught — the old startsWith() applied to EVERY entry).
  // WARP-1474 (ADR-030/031): the dashboard-QR overlay POLL. The QR-scanning
  // phone has NO bearer by design, so the global gate must let the `/status`
  // subpath through — `app.ts` mounts authMiddleware BEFORE createVpnRouter, so
  // without this a bearer-less GET …/by-token/:pending_id/status would 401 at
  // the gate and the redeem→stage→approve→status flow would be dead on a real
  // box. TRAILING SLASH (SEND-BACK #4): `/api/vpn/overlay/devices/by-token/`
  // matches the `…/by-token/<id>/status` tree but NOT a sibling like
  // `…/by-token-admin` (the char after "by-token" must be "/"), mirroring the
  // `/api/auth/invites/accept/` trailing-slash precedent. The EXACT redeem POST
  // path (`…/by-token`, no slash) is opened in the exact-match `publicPaths`
  // list above. The owner-gated siblings (/vpn/overlay/link-tokens,
  // /vpn/overlay/pending-enrollments, and the WARP-1385 POST
  // /vpn/overlay/devices) match neither, so they stay authed. The /status
  // handler re-gates itself with the X-Overlay-PoP signature + per-IP/global
  // rate limits before revealing even the coarse state.
  //
  // WARP-1757: the same trailing-slash prefix also covers
  // `…/by-token/<id>/profile`, deliberately — it is the same bearer-less
  // device using the same enrollment identity key. It re-gates itself the same
  // way, but over a DIFFERENT domain-prefixed PoP message
  // (`droplet-overlay-enroll-profile:v1:`), so a captured /status signature
  // cannot be replayed against it, and it additionally requires the enrollment
  // to be in state 'approved'.
  const PUBLIC_PREFIXES = [
    "/api/setup/box-name",
    "/api/auth/invites/accept/",
    "/api/vpn/overlay/devices/by-token/",
  ];
  const isPublic =
    publicPaths.includes(req.path) ||
    PUBLIC_PREFIXES.some((p) => req.path === p || req.path.startsWith(p));
  if (isPublic) {
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

  // Try JWT first — self-verifying signature, no network call. WARP-247:
  // tokens minted after session hardening carry a `sid` joining them to a
  // Redis session record; the record — not the signature — decides whether
  // the session is still alive (idle/absolute timeout, revocation).
  const jwtPayload = verifyAccessToken(token);
  if (jwtPayload) {
    const user: AuthUser = {
      id: jwtPayload.sub,
      username: jwtPayload.username,
      displayName: jwtPayload.displayName,
      role: jwtPayload.role,
      // PR #375 — carry the MFA-challenge timestamp through so
      // require-recent-mfa can gate sensitive routes (WARP-230).
      lastMfaAt: jwtPayload.lastMfaAt ?? null,
      sid: jwtPayload.sid,
      // WARP-1582 — spread-in, NOT `?? null`: coercing an absent claim to
      // `null` here would make it indistinguishable from "no custom role"
      // and silently authorise the read elision for every legacy token.
      ...(jwtPayload.accessRoleId !== undefined
        ? { accessRoleId: jwtPayload.accessRoleId }
        : {}),
    };

    // The JWT signature is valid; the remaining checks (denylist + session
    // record) are async, so run them in an IIFE and return. Any unexpected
    // rejection lands in the catch as a 500 — the middleware never leaves
    // the request hanging.
    void (async () => {
      try {
        // WARP-490 — access-token denylist. A hard revocation (user deleted
        // / offboarded) writes auth:denylist:user:<sub>; a still-valid
        // signature must not outlive it. Checked BEFORE the session lookup
        // so it ALSO catches sid-less grace-path tokens (which skip
        // checkSession) and fires even if the session-record sweep raced or
        // partially failed. Fails OPEN on a Redis error (isUserDenied →
        // false), the same availability posture as checkSession below.
        if (await isUserDenied(jwtPayload.sub)) {
          if (cookieToken) {
            res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
          }
          res.status(401).json({
            error: "Session revoked",
            code: "SESSION_EXPIRED",
            reason: "revoked",
          });
          return;
        }

        // WARP-247 grace path — sid-less access tokens predate session
        // records. They are unforgeable without JWT_SECRET and self-expire
        // in ≤15 min (ACCESS_TOKEN_TTL_SECONDS), so they exist only across
        // the deploy boundary; their refresh token is refused at
        // /auth/refresh (no sid), which forces one clean re-login per
        // device. Tokens minted after this release ALWAYS carry a sid.
        if (!jwtPayload.sid) {
          req.user = user;
          next();
          return;
        }

        const result = await checkSession(jwtPayload.sid);
        if (result.kind === "ok" || result.kind === "error") {
          // "error" = Redis unreachable → fail OPEN: the JWT itself is a
          // valid ≤15-min credential and a cache restart must not brick
          // every route (same availability posture as
          // requirePasswordChangeGate). session.service already logged it.
          req.user = user;
          next();
          return;
        }
        // "expired" (idle/absolute — audited inside checkSession) or
        // "missing" (revoked / GC'd). Either way this session is dead NOW,
        // even though the JWT signature is still valid — that immediacy is
        // the whole point of the server-side record.
        if (cookieToken) {
          res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
        }
        res.status(401).json({
          error: "Session expired",
          code: "SESSION_EXPIRED",
          reason: result.kind === "expired" ? result.reason : "revoked",
        });
      } catch (err) {
        logger.error({ err }, "Session check failed");
        res.status(500).json({ error: "Authentication service error" });
      }
    })();
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

  // Try JWT first. WARP-247: a sid-carrying token must also present a live
  // session record — a WS upgrade is user activity, so the default sliding
  // touch applies. Redis errors fail OPEN (same posture as the HTTP path).
  const jwtPayload = verifyAccessToken(token);
  if (jwtPayload) {
    // WARP-490 — a revoked subject must not complete a WS upgrade either.
    // Fails open on Redis error (isUserDenied → false), same as the HTTP path.
    if (await isUserDenied(jwtPayload.sub)) return null;
    if (jwtPayload.sid) {
      const result = await checkSession(jwtPayload.sid);
      if (result.kind !== "ok" && result.kind !== "error") return null;
    }
    return {
      id: jwtPayload.sub,
      username: jwtPayload.username,
      displayName: jwtPayload.displayName,
      role: jwtPayload.role,
      sid: jwtPayload.sid,
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
  if (cached) {
    // ADR-013 (SCIM): the cached AuthUser was normalised at write time, but a
    // directory deactivation (active:false / DELETE → DEACTIVATED, soft) can
    // land while the entry is still warm. Without this re-check a deactivated
    // user keeps passing auth for up to TOKEN_CACHE_TTL. Re-validate the soft
    // status on every hit via an indexed single-column select on the primary
    // key (cheap; no full-row fetch), and purge the stale entry on rejection.
    // Mirrors the DEACTIVATED gate /auth/login, SSO, and WebAuthn enforce.
    if (authPrisma) {
      const row = await authPrisma.user.findUnique({
        where: { id: cached.id },
        select: { directoryStatus: true },
      });
      if (!row || row.directoryStatus === "DEACTIVATED") {
        await cacheDel(cacheKey);
        return { kind: "invalid" };
      }
      return { kind: "ok", user: cached };
    }
    // authPrisma not wired yet — treat as a cache miss so the DEACTIVATED
    // re-check cannot be silently skipped; fall through to the live lookup.
  }

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
    // ADR-013 (SCIM): a directory-deactivated row must be denied here too — and,
    // critically, must NOT be written to the token cache below (a cached entry
    // would otherwise survive for TOKEN_CACHE_TTL even after offboarding). Mirror
    // the DEACTIVATED gate at webauthn.ts:397 / the /auth/login + SSO paths.
    if (localUser.directoryStatus === "DEACTIVATED") {
      logger.warn(
        { ncUsername, userId: localUser.id },
        "OCS auth: directory user is deactivated; rejecting token (ADR-013)",
      );
      return { kind: "invalid" };
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
  {
    // WARP-268: the host-side egress-audit collector presents this Bearer
    // on POST /api/security/egress-anomaly (unlisted-destination /
    // allowlist-unavailable events → signed activity log). Host-side
    // systemd unit, reaches the orchestrator on 127.0.0.1:3000 like the
    // WARP-468/470 samplers.
    token: config.SERVICE_TOKEN_EGRESS_AUDIT,
    principal: {
      id: "_service:egress-audit",
      username: "_service:egress-audit",
      displayName: "Egress Audit Collector",
      role: "service",
    },
  },
  {
    // RAGAS eval-runner auth: the rag-eval container's ragas_runner.py
    // presents this Bearer on GET /api/admin/retrieval-eval/search (the
    // Python client sends it as ORCHESTRATOR_SERVICE_TOKEN; the
    // orchestrator stores it as SERVICE_TOKEN_RAG_EVAL — compose wires
    // both ends to the same `secrets.sh`-generated value). Without it,
    // every eval search 401s on an AUTH_ENABLED box and the eval scores
    // empty contexts.
    token: config.SERVICE_TOKEN_RAG_EVAL,
    principal: {
      id: "_service:rag-eval",
      username: "_service:rag-eval",
      displayName: "RAG Eval Runner",
      role: "service",
    },
  },
  {
    // WARP-1800: the rack panel's device-bridge presents this Bearer on GET
    // /api/network/wifi/join-code — the ONE route this principal may reach
    // (pinned by requireRoleOrService, so the coarse `service` role shared by
    // every principal above is not enough).
    //
    // Same token as the orchestrator → oled-display leg (WARP-165); compose
    // already gives both ends the value, so this adds a direction, not a
    // secret. The panel needs the household join code because its old source
    // — the box's own hostapd via the bridge's /openwrt/qr — does not exist
    // on the edge-router shape, where the household SSID lives only on the
    // approved AP.
    token: config.SERVICE_TOKEN_DISPLAY,
    principal: {
      id: "_service:display",
      username: "_service:display",
      displayName: "Rack Panel Bridge",
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
 * WARP-237: ACL denials are mandatory-emit policy violations. Fire-and-forget
 * (`void`) — the 403 must not wait on the append lock, and recordActivity is
 * a no-op pre-init so this is safe in every test/boot ordering. Known
 * trade-off: a misbehaving client can generate one row per denied request
 * (same posture as the sign-in-throttle rows); dedup is a follow-up if it
 * proves noisy.
 *
 * WARP-1062 (audit item B): exported so the LOCAL guards that mirror
 * requireRole — the route-file `isAdmin()` helpers, audit-roots
 * `requireOwnerOrAdmin`, the SCIM bearer guard — emit the same
 * policy-violation row instead of denying silently.
 */
export function recordAccessDenied(req: Request, reason: string): void {
  void recordActivity({
    kind: "auth",
    severity: "warn",
    sourceIcon: "shield-off",
    what: "Access denied",
    sub: `${req.method} ${req.path}`,
    refs: {
      path: req.path,
      method: req.method,
      role: req.user?.role ?? null,
      reason,
    },
    actor: actorFromRequest(req),
  });
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
  return markAsRoleGuard((req: Request, res: Response, next: NextFunction): void => {
    const role = req.user?.role;
    if (typeof role !== "string" || role.length === 0) {
      recordAccessDenied(req, "no-role");
      res.status(403).json({ error: "Forbidden: no role on session" });
      return;
    }
    if (!allowedSet.has(role)) {
      recordAccessDenied(req, "role-not-permitted");
      res.status(403).json({ error: "Forbidden: role not permitted" });
      return;
    }
    next();
  });
}

/**
 * Marker stamped on every role-guard middleware.
 *
 * A router can be walked to enumerate its routes, but the handlers in each
 * layer are anonymous closures — there is no way to tell "this route is
 * guarded" from "this route has two handlers" without one. WARP-1961 needs
 * that distinction to assert a standing invariant: *no camera route ships
 * without a guard*. Counting middleware would pass for any route that
 * happens to have a validator in front of it, which is exactly the kind of
 * test that stays green while the thing it claims to check rots.
 *
 * Non-enumerable so it never shows up in logs or serialisation.
 */
export const ROLE_GUARD_MARKER = Symbol.for("droplet.roleGuard");

/** True when `fn` is a role guard produced by this module. */
export function isRoleGuard(fn: unknown): boolean {
  if (typeof fn !== "function") return false;
  return (fn as unknown as Record<symbol, unknown>)[ROLE_GUARD_MARKER] === true;
}

function markAsRoleGuard<T extends object>(fn: T): T {
  Object.defineProperty(fn, ROLE_GUARD_MARKER, {
    value: true,
    enumerable: false,
    writable: false,
  });
  return fn;
}

/**
 * Variant of `requireRole` that ALSO admits the MCP server's service
 * principal (`_service:mcp`) — that exact principal id, NOT the coarse
 * "service" role shared by voice/email-indexer.
 *
 * Why: LLM network tools dispatch through the mcp-server, which calls
 * back into the orchestrator's /api/network/* write routes presenting
 * the WARP-339 service bearer. Those routes' own safety layer
 * (`evaluateNetworkCommand`) still classifies, rate-limits, audits, and
 * mints Tier-2 confirmation tokens for every call — this guard only
 * lets the tool path REACH that layer instead of 403ing in front of it.
 * Human RBAC is unchanged: chat users without owner/admin never see
 * write tools (routes/llm.ts `narrowAllowedToolsForRole`), and external
 * MCP clients pass per-tool RBAC at the mcp-server before any dispatch.
 */
export function requireRoleOrMcpService(
  ...allowed: Role[]
): (req: Request, res: Response, next: NextFunction) => void {
  const base = requireRole(...allowed);
  return markAsRoleGuard((req: Request, res: Response, next: NextFunction): void => {
    if (req.user?.id === "_service:mcp" && req.user.role === "service") {
      next();
      return;
    }
    base(req, res, next);
  });
}

/**
 * Generalisation of `requireRoleOrMcpService`: admit exactly ONE pinned
 * service principal by id (`serviceId`, e.g. `"_service:rag-eval"`) — the id
 * AND the `service` role must both match, so the coarse "service" role shared
 * by every other principal is never enough — otherwise defer to plain
 * `requireRole(...allowed)` semantics.
 *
 * First consumer: the RAGAS eval-runner's `_service:rag-eval` principal on
 * GET /api/admin/retrieval-eval/search (routes/admin-retrieval-eval.ts).
 */
export function requireRoleOrService(
  serviceId: string,
  ...allowed: Role[]
): (req: Request, res: Response, next: NextFunction) => void {
  const base = requireRole(...allowed);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.user?.id === serviceId && req.user.role === "service") {
      next();
      return;
    }
    base(req, res, next);
  };
}

/**
 * WARP-824 — paths an authenticated-but-must-change-password session may
 * still reach. Everything else 403s `PASSWORD_CHANGE_REQUIRED` until the
 * user picks a new password.
 *
 *   • POST /api/auth/change-password — the remediation endpoint itself.
 *   • GET  /api/auth/me              — so the dashboard can read the
 *                                      `mustChangePassword` signal and render
 *                                      the change-password screen.
 *   • POST /api/auth/logout          — the user can always bail out.
 *   • POST /api/auth/refresh         — keeps the (still-gated) session alive
 *                                      across the 15-min access-token TTL
 *                                      while they're on the change screen;
 *                                      refresh issues a token but the gate
 *                                      re-checks the DB flag on the next
 *                                      request, so this is not a bypass.
 *
 * Exact paths — NOT a `/api/auth/` prefix — so a future auth route isn't
 * silently exempted from the gate.
 */
const PASSWORD_CHANGE_ALLOWED_PATHS: ReadonlySet<string> = new Set([
  "/api/auth/change-password",
  "/api/auth/me",
  "/api/auth/logout",
  "/api/auth/refresh",
]);

/**
 * WARP-824 — server-enforced forced-password-change gate.
 *
 * Mounts AFTER `authMiddleware` (so `req.user` is populated) and BEFORE every
 * protected router. For an authenticated HUMAN session it reads the EXPLICIT
 * `User.mustChangePassword` flag FRESH from the row (keyed by the
 * `req.user.id` UUID) and, when the flag is set, returns 403
 * `PASSWORD_CHANGE_REQUIRED` for every route except
 * `PASSWORD_CHANGE_ALLOWED_PATHS`.
 *
 * This is the SERVER half of the gate (the dashboard also redirects, but that
 * is convenience): the decision is made from DB state, not the JWT claim, so a
 * client that ignores the redirect — or replays a token minted before the
 * flag was read — still can't touch a protected route.
 *
 * Never gates:
 *   • a request with no `req.user` (auth disabled, or a public path the
 *     upstream middleware already let through) — nothing to gate;
 *   • a `service` principal — service tokens have no directory row and never
 *     go through a human first-login flow; gating them would break the
 *     voice/MCP/email/sampler integrations.
 *
 * Fails OPEN on a missing row or a DB read error: the gate's job is to FORCE a
 * change for a user the directory says must change, not to be a second
 * authentication layer. A row that can't be found carries no `true` flag, and
 * a transient DB blip must not 503 the whole app — the downstream RBAC /
 * self-action guards still apply. (A user who genuinely must change but whose
 * read momentarily failed is re-gated on their next request.)
 */
export function requirePasswordChangeGate(
  prisma: Pick<PrismaClient, "user">,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;
    // No session, or a service principal → never gated.
    if (!user || user.role === "service") {
      next();
      return;
    }
    // The remediation surface is always reachable. Normalise a trailing slash
    // before the exact-match lookup so `/api/auth/change-password/` resolves the
    // same as `/api/auth/change-password` — otherwise a must-change user is
    // locked out of the very endpoint that clears the flag. Collapse only
    // trailing slashes; the root "/" is preserved.
    const allowPath = req.path.replace(/\/+$/, "") || "/";
    if (PASSWORD_CHANGE_ALLOWED_PATHS.has(allowPath)) {
      next();
      return;
    }

    // Read the flag FRESH from the row — never from the JWT claim — so the
    // gate reflects the current directory state and can't be replayed past.
    prisma.user
      .findUnique({
        where: { id: user.id },
        select: { mustChangePassword: true },
      })
      .then((row) => {
        if (row?.mustChangePassword === true) {
          res.status(403).json({
            error:
              "You must change your temporary password before continuing.",
            code: "PASSWORD_CHANGE_REQUIRED",
          });
          return;
        }
        next();
      })
      .catch((err) => {
        // Fail OPEN (see docstring): log and continue rather than 503 the app
        // on a transient read failure. The user is re-gated next request.
        logger.warn(
          { err, userId: user.id },
          "password-change gate: flag read failed; allowing request through (fail-open)",
        );
        next();
      });
  };
}
