import { Router } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import pino from "pino";
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
import { SESSION_COOKIE_NAME, REFRESH_COOKIE_NAME } from "../middleware/auth.js";
import { config } from "../config.js";

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
// ────────────────────────────────────────────────────────────────
export function createPublicAuthRouter(): Router {
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
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      // Fetch user details (groups included) to determine role
      const ncUser = await ncGetCurrentUser(result.token);

      const userId = ncUser?.id || result.loginName;
      const username = ncUser?.id || result.loginName;
      const displayName = ncUser?.displayName || result.loginName;
      const role: Role = roleFromGroups(ncUser?.groups ?? []);

      // We've captured everything we need from Nextcloud. Revoke the
      // app-password we were just issued so it can't be used as a
      // long-lived credential if it ever leaks — from here on the browser
      // only holds our short-lived JWT access token.
      try {
        await ncDeleteAppPassword(result.token);
      } catch (err) {
        logger.warn({ err }, "Failed to revoke Nextcloud app password after login (non-fatal)");
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

  return router;
}

// ────────────────────────────────────────────────────────────────
// Protected auth routes — mounted AFTER the auth middleware
// so req.user is populated by the middleware.
// ────────────────────────────────────────────────────────────────
export function createProtectedAuthRouter(): Router {
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

      // Best-effort Nextcloud app password revocation for legacy (non-JWT)
      // tokens. After the login-path change, fresh sessions no longer hold a
      // Nextcloud token — only grandfathered legacy sessions do. Skip the
      // OCS call for JWTs to avoid a guaranteed-failing round-trip.
      const token = resolveToken(req);
      if (token && !verifyAccessToken(token)) {
        try {
          await ncDeleteAppPassword(token);
        } catch {
          // Non-fatal — token may already be revoked or expired
        }
      }

      res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      res.clearCookie(REFRESH_COOKIE_NAME, { path: "/api/auth" });

      res.json({ status: "ok" });
    } catch (err) {
      next(err);
    }
  });

  // ── List users (admin only) ──
  router.get("/auth/users", async (req, res, next) => {
    try {
      const token = resolveToken(req);
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
  router.post("/auth/users", async (req, res, next) => {
    try {
      const parsed = createUserSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
        return;
      }

      const token = resolveToken(req);
      if (!token) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      await ncCreateUser(token, parsed.data.username, parsed.data.password, parsed.data.displayName);

      res.status(201).json({ status: "ok", username: parsed.data.username });
    } catch (err: any) {
      if (err.message?.includes("102")) {
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
  router.put("/auth/users/:username", async (req, res, next) => {
    try {
      const token = resolveToken(req);
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
  router.post("/auth/users/:username/disable", async (req, res, next) => {
    try {
      const token = resolveToken(req);
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
  });

  router.post("/auth/users/:username/enable", async (req, res, next) => {
    try {
      const token = resolveToken(req);
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
  });

  // ── Delete user (admin only) ──
  router.delete("/auth/users/:username", async (req, res, next) => {
    try {
      const token = resolveToken(req);
      if (!token) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      await ncDeleteUser(token, req.params.username);

      res.json({ status: "deleted", username: req.params.username });
    } catch (err) {
      next(err);
    }
  });

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
