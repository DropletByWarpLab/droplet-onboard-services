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

export function createAuthRouter(): Router {
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

  // ── Login: get app password token ──
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
        ? result.token // pass through for basic auth
        : result.token;

      const user = await ncGetCurrentUser(tokenForAuth);

      res.json({
        token: result.token,
        user: user || { id: result.loginName, displayName: result.loginName, email: null },
      });
    } catch (err) {
      next(err);
    }
  });

  // ── Logout: revoke app password ──
  router.post("/auth/logout", async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.slice(7);
        await ncDeleteAppPassword(token);
        // Clear token from cache
        await cacheDel(`auth:token:*`);
      }
      res.json({ status: "ok" });
    } catch (err) {
      next(err);
    }
  });

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

  // ── List users (admin only) ──
  router.get("/auth/users", async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const token = authHeader.slice(7);
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

      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const token = authHeader.slice(7);
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
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const token = authHeader.slice(7);
      await ncDeleteUser(token, req.params.username);

      res.json({ status: "deleted", username: req.params.username });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
