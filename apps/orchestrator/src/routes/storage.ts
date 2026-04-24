import { Router } from "express";
import pino from "pino";
import { ncGetUserQuota } from "../services/nextcloud.client.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";
import type { StorageStats } from "../types/index.js";

const logger = pino({ name: "storage-route" });

/**
 * The device-bridge runs on the Jetson host and exposes auto-mounted
 * USB drives at /drives. The orchestrator reads through so the
 * dashboard doesn't need to know about host-side plumbing.
 */
const BRIDGE_URL = process.env.BRIDGE_URL || "http://172.17.0.1:9090";

interface BridgeDrive {
  device: string;
  mount: string;
  label: string;
  uuid: string;
  size_bytes: number;
  used_bytes: number;
  free_bytes: number;
  mounted: boolean;
}

interface BridgeDrivesSnapshot {
  drives: BridgeDrive[];
  count: number;
  snapshot_at: string;
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
      const token = await resolveNcToken(req);
      if (!token) {
        // No resolvable Nextcloud credential — most likely an orphan session
        // that pre-dates the NC-session store. Fall back to empty stats so
        // the dashboard renders cleanly rather than 500-ing.
        res.json({ used: 0, total: 0, available: 0, percentage: 0 } as StorageStats);
        return;
      }
      const quota = await ncGetUserQuota(token);
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

  /**
   * GET /api/storage/drives — USB drives auto-mounted on the Jetson host.
   *
   * Reads from the device-bridge (services/oled-display/device-bridge.py)
   * running on the host at :9090. Bridge reads from the automount
   * state file, so the mount set here matches what the on-screen UI
   * and Nextcloud show.
   */
  router.get("/storage/drives", async (_req, res) => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(`${BRIDGE_URL}/drives`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) {
        res.status(502).json({ drives: [], count: 0,
          error: `bridge returned ${r.status}` });
        return;
      }
      const snap = (await r.json()) as BridgeDrivesSnapshot;
      res.json(snap);
    } catch (err) {
      logger.warn({ err }, "Failed to fetch drives from device-bridge");
      res.json({ drives: [], count: 0,
        error: (err as Error).message || "bridge unreachable" });
    }
  });

  return router;
}
