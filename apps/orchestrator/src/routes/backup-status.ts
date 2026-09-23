import { Router } from "express";
import { requireRole } from "../middleware/auth.js";
import { backupHealth, readHostStatus } from "../services/backup-health.service.js";

/**
 * WARP-1405 — backup health, for the owner (Settings → Device information).
 * Read-only, owner/admin, mounted after authMiddleware. Reads the same host
 * status file the hourly backup-health job reads, through the same pure
 * `backupHealth`, so the card and the notification never disagree.
 */
export function createBackupStatusRouter(): Router {
  const router = Router();
  router.get("/backup/status", requireRole("owner", "admin"), async (_req, res) => {
    res.json(backupHealth(await readHostStatus()));
  });
  return router;
}
