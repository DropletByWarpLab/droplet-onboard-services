import { Router, Request } from "express";
import pino from "pino";
import { ncGetUserQuota } from "../services/nextcloud.client.js";
import { SESSION_COOKIE_NAME } from "../middleware/auth.js";
import type { StorageStats } from "../types/index.js";

const logger = pino({ name: "storage-route" });

function getToken(req: Request): string {
  const cookieToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (cookieToken) return cookieToken;
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return "";
  return header.slice(7);
}

/**
 * GET /api/storage — return the authenticated user's Nextcloud storage quota.
 *
 * Nextcloud enforces per-user quotas via OCS `/cloud/user`. We proxy that
 * call so the dashboard sees one consistent storage view regardless of
 * which user is logged in.
 */
export function createStorageRouter(): Router {
  const router = Router();

  router.get("/storage", async (req, res, next) => {
    try {
      const quota = await ncGetUserQuota(getToken(req));
      if (!quota) {
        res.json({ used: 0, total: 0, available: 0, percentage: 0 } as StorageStats);
        return;
      }
      const total = quota.total ?? 0;
      const used = quota.used ?? 0;
      const available = quota.free ?? Math.max(0, total - used);
      const percentage = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
      res.json({ used, total, available, percentage } as StorageStats);
    } catch (err) {
      logger.warn({ err }, "Failed to fetch Nextcloud quota");
      next(err);
    }
  });

  return router;
}
