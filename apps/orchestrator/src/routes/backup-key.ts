import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { sensitiveRateLimit } from "../middleware/rate-limit.js";
import { createRequireRecentMfa } from "../middleware/require-recent-mfa.js";
import { actorFromRequest } from "../services/activity.service.js";
import { BackupKeyExportError, exportBackupKeyOnce } from "../services/backup-key-export.service.js";

/**
 * WARP-3610 -- POST /api/backup/key/export: the owner takes the backup
 * repository key off the box, once. Owner only (an admin cannot escrow the key
 * to themselves), fresh step-up (same gate as audit-key rotation), audited.
 * The second call answers 409; the key is never returned by any other route.
 */
export function createBackupKeyRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.post(
    "/backup/key/export",
    sensitiveRateLimit,
    (req, res, next) => {
      if (req.user?.role !== "owner") {
        res.status(403).json({ error: "owner role required" });
        return;
      }
      next();
    },
    createRequireRecentMfa(),
    async (req, res, next) => {
      try {
        const key = await exportBackupKeyOnce(prisma, {
          deviceSecretKey: config.DEVICE_SECRET_KEY,
          actor: actorFromRequest(req),
          actorUsername: req.user?.username ?? null,
        });
        res.set("Cache-Control", "no-store");
        res.json({ key });
      } catch (err) {
        if (err instanceof BackupKeyExportError) {
          res.status(err.status).json({ error: err.message, code: err.code });
          return;
        }
        next(err);
      }
    },
  );
  return router;
}
