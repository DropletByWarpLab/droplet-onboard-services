import { Router } from "express";
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
} from "../services/nextcloud.client.js";
import { cacheDel } from "../services/cache.service.js";
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_MS } from "../middleware/auth.js";

const logger = pino({ name: "auth-route" });

const setupSchema = z.object({
  username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9._-]+$/, "Username must be alphanumeric"),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(128).optional(),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const createUserSchema = z.object({
  username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9._-]+$/, "Username must be alphanumeric"),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(128).optional(),
});

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

  // ── Login: validate credentials, set session cookie ──
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

      // Fetch user details with the new token
      const tokenForAuth = result.token.startsWith("basic:")
        ? result.token
        : result.token;

      const user = await ncGetCurrentUser(tokenForAuth);

      // Set HTTP-only session cookie.
      // Secure flag is set when the request arrived over HTTPS (via nginx TLS).
      const isHttps =
        req.secure || req.headers["x-forwarded-proto"] === "https";

      res.cookie(SESSION_COOKIE_NAME, result.token, {
        httpOnly: true,
        secure: isHttps,
        sameSite: "lax",
        path: "/",
        maxAge: SESSION_MAX_AGE_MS,
      });

      // Only return user info — the token is in the HTTP-only cookie,
      // never exposed to JavaScript.
      res.json({
        user: user || { id: result.loginName, username: result.loginName, displayName: result.loginName },
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
      });
    } catch (err) {
      next(err);
    }
  });

  // ── Logout: revoke token + clear cookie ──
  router.post("/auth/logout", async (req, res, next) => {
    try {
      const token = resolveToken(req);

      if (token) {
        await ncDeleteAppPassword(token);
        await cacheDel(`auth:token:*`);
      }

      // Clear the session cookie
      res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });

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

      const users = await ncListUsers(token);
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
