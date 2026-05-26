import { Router, Request } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import pino from "pino";
import {
  generateInviteToken,
  findInviteByToken,
  isExpired,
  isUsed,
  isRevoked,
} from "../services/invite.service.js";
import {
  ncCheckSetupRequired,
  ncInstallAndCreateAdmin,
  ncLoginWithCredentials,
  ncDeleteAppPassword,
  ncGetCurrentUser,
  ncCreateUser,
  ncDeleteUser,
  ncListUsers,
  ncUpdateUser,
  ncSetUserEnabled,
  ncOAuth2AuthorizeUrl,
  ncOAuth2ExchangeCode,
  ncOAuth2RefreshToken,
  NextcloudUserExistsError,
} from "../services/nextcloud.client.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  denyRefreshToken,
  claimRefreshRotation,
  roleFromGroups,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  type Role,
} from "../services/jwt.service.js";
import {
  SESSION_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  requireRole,
} from "../middleware/auth.js";
import {
  storeNcToken,
  getNcToken,
  deleteNcToken,
  touchNcToken,
  resolveNcToken,
} from "../services/nextcloud-session.service.js";
import { config } from "../config.js";
import { purgeUserData } from "../services/brain-memory.service.js";
import { recordActivity } from "../services/activity.singleton.js";

/** WARP-456: caller IP for auth audit rows. Prefers `X-Forwarded-For`
 *  (set by the nginx gateway in production), falls back to req.ip. */
function callerIpFromReq(req: Request): string | undefined {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0]!.trim();
  }
  return req.ip;
}

const logger = pino({ name: "auth-route" });

const RESERVED_USERNAMES = ["admin", "root"];

const usernameField = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/, "Username must be alphanumeric")
  .refine(
    (val) => !RESERVED_USERNAMES.includes(val.toLowerCase()),
    "This username is reserved and cannot be used",
  );

const setupSchema = z.object({
  username: usernameField,
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(128).optional(),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const createUserSchema = z.object({
  username: usernameField,
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(128).optional(),
});

// ── WARP-217 invite schemas ──
// WARP-171: widened from the legacy ["user", "admin"] union to the full
// Role enum so the DB column (now typed as `Role`) and the request body
// share a vocabulary. Legacy "user" sent by older dashboard builds is
// coerced to "family" via the preprocessor so existing clients keep
// working through one rolling deploy window — the dashboard should be
// updated to send the canonical names in a follow-up.
//
// `service` is excluded because a service principal is never minted by
// an invite — those are env-var-only (SERVICE_TOKEN_*).
const inviteRoleField = z.preprocess(
  (v) => (v === "user" ? "family" : v),
  z.enum(["owner", "admin", "family", "guest"]),
);

const createInviteSchema = z.object({
  username: usernameField,
  displayName: z.string().min(1).max(128).optional(),
  email: z.string().email().max(200).optional(),
  role: inviteRoleField.default("family"),
  // Acceptance window in hours (1h–30d). Default 72h.
  ttlHours: z.number().int().min(1).max(720).optional(),
});

const acceptInviteSchema = z.object({
  password: z.string().min(8).max(128),
});

// WARP-171: the legacy `isAdmin(req)` helper was inlined-and-removed
// when every invite-management route was switched to
// `requireRole("owner", "admin")`. The two-value contract is now
// expressed at route registration where reviewers can see it.

/** Best-effort source IP for the audit trail. Honours `trust proxy`. */
function getRequestIp(req: Request): string | null {
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

/** Build the absolute invite URL for the issued token. */
function buildInviteUrl(req: Request, token: string): string {
  const protocol = req.secure || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  return `${protocol}://${host}/invite/${token}`;
}

const updateUserSchema = z
  .object({
    displayName: z.string().min(1).max(128).optional(),
    email: z.string().email().max(200).optional(),
    // Accept either a byte count (1073741824) or a human string ("5 GB", "none").
    quota: z.union([z.string().min(1).max(32), z.number().int().min(0)]).optional(),
    password: z.string().min(8).max(128).optional(),
  })
  .refine(
    (d) =>
      d.displayName !== undefined ||
      d.email !== undefined ||
      d.quota !== undefined ||
      d.password !== undefined,
    { message: "At least one field is required" }
  );

/** Build the OAuth2 callback redirect URI from the current request. */
function getRedirectUri(req: import("express").Request): string {
  const protocol = req.secure || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  return `${protocol}://${req.headers.host}/api/auth/callback`;
}

/**
 * Resolve the session token from cookie (browser) or Authorization header (API client).
 */
function resolveToken(req: import("express").Request): string | null {
  const cookieToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (cookieToken) return cookieToken;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);

  return null;
}

// ────────────────────────────────────────────────────────────────
// Public auth routes — mounted BEFORE the auth middleware
//
// `prisma` is optional for backward compatibility with the legacy
// createAuthRouter() shim, but the WARP-217 invite-accept endpoints need
// it. When called without prisma those routes simply 404 (the dashboard's
// `getInvite` / `acceptInvite` calls will treat that as "invite not found"
// which is the right default for an under-configured deployment).
//
// WARP-485 round 2 — JWT-path normalization callsites (this file owns
// the only places where `id` enters the JWT subject claim or the NC
// token cache key; the OCS auth path was already normalized in round 1
// inside `src/middleware/auth.ts`):
//
//   1. POST /api/auth/login        — line ~275: signAccessToken({ id })
//                                  — line ~267: storeNcToken(id, ...)
//   2. POST /api/auth/refresh      — line ~447: signAccessToken({ id })
//                                  — line ~452: touchNcToken(id, ...)
//   3. POST /api/auth/invites/accept/:token
//                                  — line ~674: signAccessToken({ id })
//   4. POST /api/auth/logout       — line ~768: getNcToken(req.user.id)
//                                  — line ~776: deleteNcToken(req.user.id)
//
// Contract: every `id` fed to signAccessToken / signRefreshToken / NC
// token store helpers in this file is the **local `User.id` UUID**,
// resolved by looking up the local `User` row whose `nextcloudUsername`
// matches the Nextcloud user id returned by OCS. The pre-WARP-485 shape
// fed the NC username string into `JWT.sub`, which bypassed WARP-480's
// self-action guard at `/api/people/:id` under JWT auth (`req.user.id`
// = NC username, `req.params.id` = UUID → string mismatch → guard
// silently skipped).
//
// Fail-closed posture (matches the OCS path's WARP-485 round-1
// behavior): when no local User row exists for the authenticated
// Nextcloud user, the route returns 401 + `USER_NOT_PROVISIONED`
// instead of minting a synthetic id. Silent auto-provision would be
// a privilege-escalation vector — an attacker holding a valid OCS
// credential for an unrelated NC user could otherwise mint a default-
// `family`-role local row.
// ────────────────────────────────────────────────────────────────
export function createPublicAuthRouter(
  prisma?: import("@prisma/client").PrismaClient,
): Router {
  const router = Router();

  // ── Check if initial setup is required ──
  router.get("/auth/setup", async (_req, res, next) => {
    try {
      const setupRequired = await ncCheckSetupRequired();
      res.json({ setupRequired });
    } catch (err) {
      next(err);
    }
  });

  // ── Initial setup: create the first admin user ──
  router.post("/auth/setup", async (req, res, next) => {
    try {
      const parsed = setupSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
        return;
      }

      const { username, password, displayName } = parsed.data;

      await ncInstallAndCreateAdmin(username, password, displayName);
      logger.info({ username }, "Initial admin user created");

      res.json({ status: "ok", username });
    } catch (err: any) {
      logger.error({ err }, "Setup failed");
      res.status(500).json({ error: err.message || "Setup failed" });
    }
  });

  // ── Login: validate credentials, issue JWT tokens ──
  router.post("/auth/login", async (req, res, next) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Username and password are required" });
        return;
      }

      const result = await ncLoginWithCredentials(parsed.data.username, parsed.data.password);
      if (!result) {
        // WARP-456: failed login audit row. We intentionally include
        // the attempted username so an audit reviewer can spot
        // patterns; the password never reaches the recorder.
        await recordActivity({
          kind: "auth",
          severity: "warn",
          sourceIcon: "shield-alert",
          what: "Sign-in failed",
          sub: `${parsed.data.username} • ${callerIpFromReq(req) ?? "unknown"}`,
          refs: {
            outcome: "invalid_credentials",
            username: parsed.data.username,
            ip: callerIpFromReq(req) ?? null,
          },
        });
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      // Fetch user details (groups included) to determine role
      const ncUser = await ncGetCurrentUser(result.token);

      const ncUsername = ncUser?.id || result.loginName;
      const displayName = ncUser?.displayName || result.loginName;
      const role: Role = roleFromGroups(ncUser?.groups ?? []);

      // WARP-485 round 2 — resolve the local User row by `nextcloudUsername`
      // BEFORE signing the JWT, so `JWT.sub = localUser.id` (UUID) instead
      // of the NC username string. Fail-closed when no local row matches:
      // the operator must explicitly provision the user via /api/people
      // before they can authenticate. Silent auto-provision would be a
      // privilege-escalation vector — an attacker who somehow holds a
      // valid OCS credential for an unrelated NC user could otherwise
      // mint a default-`family`-role local row.
      //
      // The shim createAuthRouter() in legacy code paths calls
      // createPublicAuthRouter() without prisma; we treat that the same
      // as "no matching row" so a misconfigured deployment can't sneak
      // past with an unnormalized id either.
      if (!prisma) {
        logger.warn(
          { ncUsername },
          "JWT login: prisma not wired into public auth router; failing closed (WARP-485 round 2)",
        );
        res.status(401).json({
          error:
            "User not provisioned. Ask an owner to add this account via /api/people.",
          code: "USER_NOT_PROVISIONED",
        });
        return;
      }
      const localUser = await prisma.user.findUnique({
        where: { nextcloudUsername: ncUsername },
      });
      if (!localUser) {
        logger.warn(
          { ncUsername },
          "JWT login: no local User row for Nextcloud user; operator must provision via /api/people (WARP-485 round 2)",
        );
        res.status(401).json({
          error:
            "User not provisioned. Ask an owner to add this account via /api/people.",
          code: "USER_NOT_PROVISIONED",
        });
        return;
      }

      const userId = localUser.id; // local UUID — fed into JWT.sub + NC store key
      const username = ncUsername; // human-readable handle (display + audit only)

      // Stash the Nextcloud app-password server-side so downstream routes
      // (files, storage, user admin) can impersonate the caller against
      // Nextcloud's WebDAV/OCS APIs — the browser only ever sees our JWT.
      // TTL matches the refresh-token lifetime; the entry is overwritten on
      // every successful login and deleted at logout.
      //
      // WARP-485 round 2 — keyed by the local User.id UUID so logout's
      // getNcToken(req.user.id) hits the same key (req.user.id is the
      // UUID across all consumers post-round-2).
      try {
        await storeNcToken(userId, result.token, REFRESH_TOKEN_TTL_SECONDS);
      } catch (err) {
        logger.error({ err }, "Failed to persist Nextcloud session token");
        res.status(500).json({ error: "Session store unavailable" });
        return;
      }

      // Issue JWT access + refresh tokens
      const accessToken = signAccessToken({ id: userId, username, displayName, role });
      const refreshToken = signRefreshToken({ id: userId, username, displayName, role });

      const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";

      // Access token in session cookie
      res.cookie(SESSION_COOKIE_NAME, accessToken, {
        httpOnly: true,
        secure: isHttps,
        sameSite: "lax",
        path: "/",
        maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
      });

      // Refresh token in separate cookie (scoped to /api/auth)
      res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
        httpOnly: true,
        secure: isHttps,
        sameSite: "lax",
        path: "/api/auth",
        maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
      });

      // WARP-456: successful sign-in audit row.
      await recordActivity({
        kind: "auth",
        severity: "ok",
        sourceIcon: "log-in",
        what: `${displayName} signed in`,
        sub: `${role} • ${callerIpFromReq(req) ?? "unknown"}`,
        refs: {
          outcome: "success",
          userId,
          username,
          role,
          ip: callerIpFromReq(req) ?? null,
        },
      });

      res.json({
        user: { id: userId, username, displayName, role },
      });
    } catch (err) {
      next(err);
    }
  });

  // ── OAuth2: Redirect to Nextcloud authorization ──
  router.get("/auth/authorize", (req, res) => {
    if (config.AUTH_MODE !== "oauth2" || !config.OAUTH2_CLIENT_ID) {
      res.status(400).json({ error: "OAuth2 is not configured. Set AUTH_MODE=oauth2 and provide OAUTH2_CLIENT_ID." });
      return;
    }

    const state = randomBytes(16).toString("hex");
    const redirectUri = getRedirectUri(req);

    // Store state in a short-lived cookie for CSRF protection
    const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.cookie("oauth2_state", state, {
      httpOnly: true,
      secure: isHttps,
      sameSite: "lax",
      maxAge: 300_000, // 5 minutes
    });

    const authorizeUrl = ncOAuth2AuthorizeUrl(config.OAUTH2_CLIENT_ID, redirectUri, state);
    res.redirect(authorizeUrl);
  });

  // ── OAuth2: Handle callback ──
  router.get("/auth/callback", async (req, res, next) => {
    try {
      if (config.AUTH_MODE !== "oauth2" || !config.OAUTH2_CLIENT_ID) {
        res.status(400).json({ error: "OAuth2 is not configured" });
        return;
      }

      const { code, state } = req.query;
      const savedState = req.cookies?.oauth2_state;

      // CSRF validation
      if (!state || !savedState || state !== savedState) {
        res.status(400).json({ error: "Invalid OAuth2 state parameter" });
        return;
      }

      // Clear the state cookie
      res.clearCookie("oauth2_state");

      if (!code || typeof code !== "string") {
        res.status(400).json({ error: "Missing authorization code" });
        return;
      }

      const protocol = req.secure || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
      const redirectUri = `${protocol}://${req.headers.host}/api/auth/callback`;

      const tokens = await ncOAuth2ExchangeCode(
        code,
        config.OAUTH2_CLIENT_ID,
        config.OAUTH2_CLIENT_SECRET,
        redirectUri
      );

      if (!tokens) {
        res.status(401).json({ error: "Failed to exchange authorization code" });
        return;
      }

      // Fetch user details with the new access token
      const user = await ncGetCurrentUser(tokens.accessToken);

      // Store tokens in HTTP-only cookies
      const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
      res.cookie(SESSION_COOKIE_NAME, tokens.accessToken, {
        httpOnly: true,
        secure: isHttps,
        sameSite: "lax",
        path: "/",
        maxAge: tokens.expiresIn * 1000,
      });

      res.cookie(REFRESH_COOKIE_NAME, tokens.refreshToken, {
        httpOnly: true,
        secure: isHttps,
        sameSite: "lax",
        path: "/api/auth",
        maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
      });

      // Redirect to dashboard with user info (or return JSON for API clients)
      if (req.headers.accept?.includes("text/html")) {
        res.redirect("/");
      } else {
        res.json({
          user: user || { id: "unknown", username: "unknown", displayName: "Unknown" },
        });
      }
    } catch (err) {
      next(err);
    }
  });

  // ── Refresh: exchange refresh token for new access token ──
  router.post("/auth/refresh", async (req, res, next) => {
    try {
      const refreshTokenCookie = req.cookies?.[REFRESH_COOKIE_NAME];
      if (!refreshTokenCookie) {
        res.status(401).json({ error: "No refresh token available" });
        return;
      }

      // --- Try JWT refresh first ---
      const refreshResult = await verifyRefreshToken(refreshTokenCookie);
      if (refreshResult) {
        // Claim exclusive rotation rights before issuing new tokens. If
        // another concurrent /auth/refresh call (e.g. a browser double-submit
        // on flaky networks) already claimed this token, reject to prevent
        // two valid token pairs from being issued for the same refresh token.
        const claimed = await claimRefreshRotation(refreshTokenCookie);
        if (!claimed) {
          res.status(401).json({ error: "Refresh token is already being rotated" });
          return;
        }

        const { sub, username, displayName, role } = refreshResult;

        // Rotate: denylist the old refresh token (overwrites the short-TTL
        // rotation claim with a full-lifetime entry) and issue a new pair.
        await denyRefreshToken(refreshTokenCookie);
        const newRefreshToken = signRefreshToken({ id: sub, username, displayName, role });
        const newAccessToken = signAccessToken({ id: sub, username, displayName, role });

        // Extend the NC session token's TTL so it doesn't expire mid-session
        // (the user would otherwise see silent 401s on /api/files after the
        // original 7-day window elapses even though their JWT is fresh).
        await touchNcToken(sub, REFRESH_TOKEN_TTL_SECONDS);

        const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
        res.cookie(SESSION_COOKIE_NAME, newAccessToken, {
          httpOnly: true,
          secure: isHttps,
          sameSite: "lax",
          path: "/",
          maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
        });
        res.cookie(REFRESH_COOKIE_NAME, newRefreshToken, {
          httpOnly: true,
          secure: isHttps,
          sameSite: "lax",
          path: "/api/auth",
          maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
        });

        res.json({ status: "ok", expiresIn: ACCESS_TOKEN_TTL_SECONDS });
        return;
      }

      // --- Fallback: OAuth2 refresh (legacy Nextcloud tokens) ---
      if (config.AUTH_MODE === "oauth2" && config.OAUTH2_CLIENT_ID) {
        const tokens = await ncOAuth2RefreshToken(
          refreshTokenCookie,
          config.OAUTH2_CLIENT_ID,
          config.OAUTH2_CLIENT_SECRET
        );

        if (!tokens) {
          res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
          res.clearCookie(REFRESH_COOKIE_NAME, { path: "/api/auth" });
          res.status(401).json({ error: "Failed to refresh token" });
          return;
        }

        const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
        res.cookie(SESSION_COOKIE_NAME, tokens.accessToken, {
          httpOnly: true,
          secure: isHttps,
          sameSite: "lax",
          path: "/",
          maxAge: tokens.expiresIn * 1000,
        });

        res.cookie(REFRESH_COOKIE_NAME, tokens.refreshToken, {
          httpOnly: true,
          secure: isHttps,
          sameSite: "lax",
          path: "/api/auth",
          maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
        });

        res.json({ status: "ok", expiresIn: tokens.expiresIn });
        return;
      }

      // Neither JWT nor OAuth2 could handle the token
      res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      res.clearCookie(REFRESH_COOKIE_NAME, { path: "/api/auth" });
      res.status(401).json({ error: "Invalid or expired refresh token" });
    } catch (err) {
      next(err);
    }
  });

  // ────────────────────────────────────────────────────────────
  // WARP-217 — Public invite-accept endpoints
  //
  // These two are mounted on the PUBLIC router because the invitee, by
  // definition, has no Droplet account yet. The token in the URL is the
  // sole authentication. We never echo the stored token back, never log
  // it, and compare it in constant time inside `findInviteByToken`.
  //
  //   GET  /api/auth/invites/accept/:token   — fetch invite metadata
  //   POST /api/auth/invites/accept/:token   — set password + create NC user
  //
  // State-machine returns:
  //   - 404 (not-found / revoked — both leak the same info to clients)
  //   - 410 GONE  with code "USED" or "EXPIRED"
  //   - 200 / 400 (bad password) / 500 (Nextcloud failure)
  // ────────────────────────────────────────────────────────────
  router.get("/auth/invites/accept/:token", async (req, res, next) => {
    try {
      if (!prisma) {
        res.status(404).json({ error: "Invite not found" });
        return;
      }
      const invite = await findInviteByToken(prisma, req.params.token);
      if (!invite || isRevoked(invite)) {
        res.status(404).json({ error: "Invite not found" });
        return;
      }
      if (isUsed(invite)) {
        res.status(410).json({ error: "This invite has already been used", code: "USED" });
        return;
      }
      if (isExpired(invite)) {
        res.status(410).json({ error: "This invite has expired", code: "EXPIRED" });
        return;
      }
      res.json({
        username: invite.username,
        displayName: invite.displayName,
        role: invite.role,
        expiresAt: invite.expiresAt,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/auth/invites/accept/:token", async (req, res, next) => {
    try {
      if (!prisma) {
        res.status(404).json({ error: "Invite not found" });
        return;
      }
      const parsed = acceptInviteSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Password must be at least 8 characters",
          code: "INVALID_PASSWORD",
        });
        return;
      }
      const { password } = parsed.data;

      const invite = await findInviteByToken(prisma, req.params.token);
      if (!invite || isRevoked(invite)) {
        res.status(404).json({ error: "Invite not found" });
        return;
      }
      if (isUsed(invite)) {
        res.status(410).json({ error: "This invite has already been used", code: "USED" });
        return;
      }
      if (isExpired(invite)) {
        res.status(410).json({ error: "This invite has expired", code: "EXPIRED" });
        return;
      }

      // Defense in depth: re-validate the username at accept time. The
      // create endpoint already runs this check, but a stale row that was
      // somehow hand-edited (or migrated in from elsewhere) must not be
      // able to land a reserved username.
      const usernameCheck = usernameField.safeParse(invite.username);
      if (!usernameCheck.success) {
        res.status(400).json({ error: "Invite has an invalid username" });
        return;
      }

      // Build the Nextcloud groups list from the invite's role.
      // WARP-171: the invite role is now the canonical Role enum (was
      // a free-form String). The mapping below preserves the
      // pre-WARP-171 wire contract — "admin" invitee still lands in
      // the Nextcloud "admin" group, which roleFromGroups() turns
      // back into the "owner" session role on first login. The new
      // enum values get explicit mappings so future invites can ask
      // for them without ambiguity. `family` (formerly "user") is
      // the empty-groups default so a regular household member lands
      // in Nextcloud's default group set.
      const groups: string[] =
        invite.role === "owner" || invite.role === "admin"
          ? ["admin"]
          : invite.role === "guest"
            ? ["guest"]
            : [];

      try {
        await ncCreateUser(
          // Use the configured admin token from env. No request-bound NC
          // token is available since the invitee isn't logged in yet.
          process.env.NEXTCLOUD_ADMIN_TOKEN ||
            Buffer.from(
              `${process.env.NEXTCLOUD_ADMIN_USER || "admin"}:${process.env.NEXTCLOUD_ADMIN_PASSWORD || ""}`,
            ).toString("base64"),
          invite.username,
          password,
          invite.displayName || undefined,
          groups,
        );
      } catch (err: any) {
        logger.error({ err, username: invite.username }, "Failed to create user from invite");
        // Typed-error path: NextcloudUserExistsError carries ocsStatus=102
        // and lets us detect user-exists without sniffing message strings.
        if (err instanceof NextcloudUserExistsError) {
          res.status(409).json({ error: "A user with this username already exists" });
          return;
        }
        res.status(500).json({ error: "Could not create your account. Please try again or ask the admin who invited you." });
        return;
      }

      // Mark the invite accepted BEFORE we issue cookies — this is the
      // single-use enforcement point. A concurrent second POST will see
      // acceptedAt non-null and 410. The DB unique-on-token + this
      // single-row update keeps the race window small (Prisma's update is
      // not transactional with the ncCreateUser call, but Nextcloud's
      // own statuscode 102 catches the user-exists race).
      const acceptedFrom = getRequestIp(req);
      await prisma.userInvite.update({
        where: { id: invite.id },
        data: {
          acceptedAt: new Date(),
          acceptedFrom: acceptedFrom ?? undefined,
        },
      });

      // Auto-login the invitee — same shape as /api/auth/login.
      // WARP-171: preserve the pre-WARP-171 wire contract — "admin"
      // invitee gets an "owner" session role (the original two-value
      // semantics) — and add direct passthrough for the three new
      // enum values an invite can now request explicitly.
      const role: Role =
        invite.role === "owner" || invite.role === "admin"
          ? "owner"
          : invite.role === "guest"
            ? "guest"
            : "family";
      const userId = invite.username;
      const accessToken = signAccessToken({
        id: userId,
        username: userId,
        displayName: invite.displayName || userId,
        role,
      });
      const refreshToken = signRefreshToken({
        id: userId,
        username: userId,
        displayName: invite.displayName || userId,
        role,
      });

      const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
      res.cookie(SESSION_COOKIE_NAME, accessToken, {
        httpOnly: true,
        secure: isHttps,
        sameSite: "lax",
        path: "/",
        maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
      });
      res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
        httpOnly: true,
        secure: isHttps,
        sameSite: "lax",
        path: "/api/auth",
        maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
      });

      logger.info(
        { username: invite.username, role: invite.role, invitedBy: invite.createdBy },
        "Invite accepted",
      );

      res.json({
        user: {
          id: userId,
          username: userId,
          displayName: invite.displayName || userId,
          role,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

// ────────────────────────────────────────────────────────────────
// Protected auth routes — mounted AFTER the auth middleware
// so req.user is populated by the middleware.
// ────────────────────────────────────────────────────────────────
export function createProtectedAuthRouter(
  prisma?: import("@prisma/client").PrismaClient,
): Router {
  const router = Router();

  // ── Get current user info ──
  router.get("/auth/me", async (req, res, next) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }

      res.json({
        id: req.user.id,
        username: req.user.username,
        displayName: req.user.displayName,
        role: req.user.role,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── Logout: denylist refresh token + clear cookies ──
  router.post("/auth/logout", async (req, res, next) => {
    try {
      // Denylist the JWT refresh token so it can't be reused
      const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
      if (refreshToken) {
        await denyRefreshToken(refreshToken);
      }

      // Revoke the stored Nextcloud app-password so it can't outlive the
      // session. Two code paths:
      //   • JWT sessions: the NC token lives in Redis keyed by user id;
      //     fetch it, ask Nextcloud to revoke, then delete from Redis.
      //   • Legacy sessions: the cookie IS the NC token; revoke it directly.
      const sessionToken = resolveToken(req);
      if (sessionToken && verifyAccessToken(sessionToken) && req.user?.id) {
        const ncToken = await getNcToken(req.user.id);
        if (ncToken) {
          try {
            await ncDeleteAppPassword(ncToken);
          } catch {
            // Non-fatal — token may already be revoked upstream
          }
        }
        await deleteNcToken(req.user.id);
      } else if (sessionToken) {
        try {
          await ncDeleteAppPassword(sessionToken);
        } catch {
          // Non-fatal — token may already be revoked or expired
        }
      }

      res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      res.clearCookie(REFRESH_COOKIE_NAME, { path: "/api/auth" });

      // WARP-456: audit row for the logout. `req.user` is set by the
      // authMiddleware before this handler runs.
      await recordActivity({
        kind: "auth",
        severity: "ok",
        sourceIcon: "log-out",
        what: req.user?.displayName
          ? `${req.user.displayName} signed out`
          : "Sign-out",
        sub: callerIpFromReq(req) ?? null,
        refs: {
          userId: req.user?.id ?? null,
          ip: callerIpFromReq(req) ?? null,
        },
      });

      res.json({ status: "ok" });
    } catch (err) {
      next(err);
    }
  });

  // ── List users (admin only) ──
  router.get("/auth/users", async (req, res, next) => {
    try {
      const token = await resolveNcToken(req);
      if (!token) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const allUsers = await ncListUsers(token);
      // Hide the Nextcloud system/database admin account — it exists for
      // internal orchestrator use only and must never appear in the UI.
      const systemUser = (process.env.NEXTCLOUD_ADMIN_USER || "admin").toLowerCase();
      const users = allUsers.filter((u) => u.id.toLowerCase() !== systemUser);
      res.json({ users });
    } catch (err: any) {
      if (err.message?.includes("403") || err.message?.includes("997")) {
        res.status(403).json({ error: "Admin access required" });
        return;
      }
      next(err);
    }
  });

  // ── Create user (admin only) ──
  // WARP-171: per-route guard. owner + admin only.
  router.post("/auth/users", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const parsed = createUserSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
        return;
      }

      const token = await resolveNcToken(req);
      if (!token) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      await ncCreateUser(token, parsed.data.username, parsed.data.password, parsed.data.displayName);

      res.status(201).json({ status: "ok", username: parsed.data.username });
    } catch (err: any) {
      // Typed-error path mirrors the invite-accept route — detect the
      // OCS user-exists race (statuscode 102) by error class, not by
      // substring-sniffing the message (which can false-positive on
      // unrelated messages that happen to contain "102").
      if (err instanceof NextcloudUserExistsError) {
        res.status(409).json({ error: "User already exists" });
        return;
      }
      next(err);
    }
  });

  // ── Update user (admin only) ──
  // Accepts any combination of displayName / email / quota / password and
  // applies them one OCS PUT at a time. Each field is independent so a
  // partial failure leaves the previously-applied fields in place.
  // WARP-171: per-route guard. owner + admin only.
  router.put("/auth/users/:username", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const token = await resolveNcToken(req);
      if (!token) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const parsed = updateUserSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid user update",
          details: parsed.error.flatten(),
        });
        return;
      }

      const { username } = req.params;
      if (parsed.data.displayName !== undefined) {
        await ncUpdateUser(token, username, "displayname", parsed.data.displayName);
      }
      if (parsed.data.email !== undefined) {
        await ncUpdateUser(token, username, "email", parsed.data.email);
      }
      if (parsed.data.quota !== undefined) {
        await ncUpdateUser(token, username, "quota", String(parsed.data.quota));
      }
      if (parsed.data.password !== undefined) {
        await ncUpdateUser(token, username, "password", parsed.data.password);
      }
      res.json({ status: "ok", username });
    } catch (err: any) {
      if (err.message?.includes("403") || err.message?.includes("997")) {
        res.status(403).json({ error: "Admin access required" });
        return;
      }
      next(err);
    }
  });

  // ── Disable / enable user (admin only) ──
  // WARP-171: per-route guard. owner + admin only.
  router.post(
    "/auth/users/:username/disable",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        const token = await resolveNcToken(req);
        if (!token) {
          res.status(401).json({ error: "Authentication required" });
          return;
        }
        await ncSetUserEnabled(token, req.params.username, false);
        res.json({ status: "disabled", username: req.params.username });
      } catch (err: any) {
        if (err.message?.includes("403") || err.message?.includes("997")) {
          res.status(403).json({ error: "Admin access required" });
          return;
        }
        next(err);
      }
    },
  );

  // WARP-171: per-route guard. owner + admin only.
  router.post(
    "/auth/users/:username/enable",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        const token = await resolveNcToken(req);
        if (!token) {
          res.status(401).json({ error: "Authentication required" });
          return;
        }
        await ncSetUserEnabled(token, req.params.username, true);
        res.json({ status: "enabled", username: req.params.username });
      } catch (err: any) {
        if (err.message?.includes("403") || err.message?.includes("997")) {
          res.status(403).json({ error: "Admin access required" });
          return;
        }
        next(err);
      }
    },
  );

  // ── Delete user (admin only) ──
  // WARP-205: Cascade brain-memory items + chunks + on-disk bytes the
  // user owned. We do this AFTER Nextcloud-side delete succeeds so a
  // failed upstream call doesn't leave the brain tier partially purged
  // (the dashboard would then list a user that no longer exists in
  // Nextcloud — strictly worse than the converse). The cascade is
  // best-effort: if it throws we still return success, but log loud
  // — orphaned local rows are recoverable later via a janitor job;
  // returning 500 here would also fail to undo the upstream delete.
  // WARP-171: per-route guard. owner + admin only.
  router.delete("/auth/users/:username", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const token = await resolveNcToken(req);
      if (!token) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      await ncDeleteUser(token, req.params.username);

      if (prisma) {
        try {
          const purged = await purgeUserData(prisma, req.params.username);
          logger.info(
            {
              username: req.params.username,
              items: purged.items,
              chunks: purged.chunks,
            },
            "Cascaded brain-memory purge after user delete",
          );
        } catch (err) {
          // Don't fail the user-delete if the local cascade trips —
          // the upstream NC delete already succeeded, and undoing it
          // is awkward. Log loud so on-call can clean up later.
          logger.error(
            { err, username: req.params.username },
            "Brain-memory cascade purge failed (user already deleted in Nextcloud)",
          );
        }
      } else {
        // Should never happen in production; createProtectedAuthRouter
        // is invoked with prisma in app.ts.
        logger.warn(
          { username: req.params.username },
          "purgeUserData skipped — protected auth router instantiated without prisma",
        );
      }

      res.json({ status: "deleted", username: req.params.username });
    } catch (err) {
      next(err);
    }
  });

  // ────────────────────────────────────────────────────────────
  // WARP-217 — Admin invite management
  //
  //   POST   /api/auth/invites           — generate a token + URL
  //   GET    /api/auth/invites           — list (most recent first)
  //   DELETE /api/auth/invites/:token    — revoke (idempotent)
  //
  // All three are admin-only. We rely on `req.user.role` populated by the
  // upstream auth middleware. Returning 403 (not 401) on non-admin matches
  // the existing ddns/vpn convention so the dashboard's "you're logged in,
  // just not allowed" path is consistent across pages.
  // ────────────────────────────────────────────────────────────
  // WARP-171: per-route guard. owner + admin only. Replaces the
  // pre-WARP-171 inline `isAdmin(req)` check; the guard runs as
  // middleware ahead of the handler so the 403 short-circuits before
  // any handler-local validation.
  router.post("/auth/invites", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      if (!prisma) {
        res.status(500).json({ error: "Invite store unavailable" });
        return;
      }
      const parsed = createInviteSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
        return;
      }

      const ttlHours = parsed.data.ttlHours ?? 72;
      const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
      const token = generateInviteToken();

      const created = await prisma.userInvite.create({
        data: {
          token,
          username: parsed.data.username,
          displayName: parsed.data.displayName ?? null,
          email: parsed.data.email ?? null,
          role: parsed.data.role,
          createdBy: req.user?.username ?? "unknown",
          expiresAt,
        },
      });

      logger.info(
        {
          username: parsed.data.username,
          role: parsed.data.role,
          createdBy: req.user?.username,
          expiresAt,
        },
        "User invite created",
      );

      res.json({
        token: created.token,
        url: buildInviteUrl(req, created.token),
        expiresAt: created.expiresAt,
      });
    } catch (err) {
      next(err);
    }
  });

  // WARP-171: GET listing of invites is also admin-only — exposing
  // pending tokens to a family-tier user would be a credential leak
  // even though the token's just-an-identifier. Same guard as the
  // POST/DELETE invite endpoints.
  router.get("/auth/invites", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      if (!prisma) {
        res.status(500).json({ error: "Invite store unavailable" });
        return;
      }
      const rows = await prisma.userInvite.findMany({
        orderBy: { createdAt: "desc" },
      });
      const invites = rows.map((r) => ({
        token: r.token,
        username: r.username,
        displayName: r.displayName,
        email: r.email,
        role: r.role,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        acceptedAt: r.acceptedAt,
        revokedAt: r.revokedAt,
      }));
      res.json({ invites });
    } catch (err) {
      next(err);
    }
  });

  // WARP-171: per-route guard. owner + admin only.
  router.delete(
    "/auth/invites/:token",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        if (!prisma) {
          res.status(500).json({ error: "Invite store unavailable" });
          return;
        }
        const invite = await findInviteByToken(prisma, req.params.token);
        if (!invite) {
          res.status(404).json({ error: "Invite not found" });
          return;
        }
        // Idempotent: revoking an already-revoked invite is a no-op success.
        if (!invite.revokedAt) {
          await prisma.userInvite.update({
            where: { id: invite.id },
            data: { revokedAt: new Date() },
          });
        }
        res.json({ revoked: true });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

/** @deprecated Use createPublicAuthRouter() + createProtectedAuthRouter() instead */
export function createAuthRouter(): Router {
  // Backward-compatible single router for any code still using the old API.
  // Combines both public and protected routes (but /auth/me will only work
  // if authMiddleware runs before this router — see app.ts).
  const router = Router();
  router.use(createPublicAuthRouter());
  router.use(createProtectedAuthRouter());
  return router;
}
