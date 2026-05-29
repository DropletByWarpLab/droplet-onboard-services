import { Router, Request } from "express";
import pino from "pino";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { ncGetUserQuota } from "../services/nextcloud.client.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";
import type { StorageStats } from "../types/index.js";

// Drive labels are device-wide config that any user (incl. family
// accounts) shares, so PATCH is admin-only — mirrors the gate around
// PUT /api/ddns/duckdns. Family users can still see the labels via the
// existing GET routes; they just can't change them.
function isAdmin(req: Request): boolean {
  const role = req.user?.role;
  return role === "owner" || role === "admin";
}

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
 * Bridge drive enriched with the customer-chosen Drive row (WARP-174).
 * `displayName` is the friendly name the customer typed in the setup
 * wizard's Storage step (or in /storage later); `null` when no Drive
 * row exists yet for this UUID.
 */
interface DriveWithLabel extends BridgeDrive {
  displayName: string | null;
  icon: string | null;
  notes: string | null;
}

const updateDriveSchema = z.object({
  displayName: z.string().trim().min(1).max(64).optional(),
  icon: z.string().trim().min(1).max(48).nullable().optional(),
  notes: z.string().trim().max(512).nullable().optional(),
});

/**
 * GET /api/storage — return the authenticated user's Nextcloud storage quota.
 *
 * Nextcloud enforces per-user quotas via OCS `/cloud/user`. We proxy that
 * call so the dashboard sees one consistent storage view regardless of
 * which user is logged in.
 */
export function createStorageRouter(prisma: PrismaClient): Router {
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
   *
   * WARP-174: each drive is enriched with the customer-chosen
   * `displayName` / `icon` / `notes` from the `Drive` table when one
   * exists. Fields are `null` for drives the customer hasn't named yet.
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

      // Single batched lookup — Drive table is tiny (one row per
      // physical drive the customer has named), so an unfiltered
      // findMany is fine. The Map keeps the join O(n) total.
      const uuids = snap.drives.map((d) => d.uuid).filter(Boolean);
      const labels = uuids.length
        ? await prisma.drive.findMany({ where: { uuid: { in: uuids } } })
        : [];
      const byUuid = new Map(labels.map((l) => [l.uuid, l]));

      const drives: DriveWithLabel[] = snap.drives.map((d) => {
        const label = byUuid.get(d.uuid);
        return {
          ...d,
          displayName: label?.displayName ?? null,
          icon: label?.icon ?? null,
          notes: label?.notes ?? null,
        };
      });

      res.json({ drives, count: snap.count, snapshot_at: snap.snapshot_at });
    } catch (err) {
      logger.warn({ err }, "Failed to fetch drives from device-bridge");
      res.json({ drives: [], count: 0,
        error: (err as Error).message || "bridge unreachable" });
    }
  });

  /**
   * PATCH /api/storage/drives/:uuid — upsert the customer's name + icon
   * + notes for a drive (WARP-174).
   *
   * Upsert semantics: first PATCH creates the row, subsequent PATCHes
   * update it. UUID is the FS UUID from the bridge; we don't verify the
   * drive is currently mounted because the customer may want to rename
   * a drive that's currently unplugged.
   *
   * Mirrors the shape of `PATCH /network/devices/:mac` from ADR-002
   * Phase 1 device intelligence.
   */
  router.patch("/storage/drives/:uuid", async (req, res, next) => {
    try {
      if (!isAdmin(req)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const { uuid } = req.params;
      // FAT/exFAT UUIDs sometimes include `:` (rare on Linux blkid output,
      // common on macOS/Windows-formatted disks); accept it alongside the
      // hyphenated EXT/NTFS-style UUIDs the original regex covered.
      if (!/^[A-Za-z0-9:-]{1,64}$/.test(uuid)) {
        return res
          .status(400)
          .json({ error: "Invalid drive UUID" });
      }
      const parsed = updateDriveSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid request",
          details: parsed.error.flatten(),
        });
      }
      const { displayName, icon, notes } = parsed.data;
      if (
        displayName === undefined &&
        icon === undefined &&
        notes === undefined
      ) {
        return res
          .status(400)
          .json({ error: "At least one of displayName / icon / notes is required" });
      }

      // Upsert. `create` requires displayName, so first-time PATCHes
      // must include it; updates can be partial.
      const existing = await prisma.drive.findUnique({ where: { uuid } });
      if (!existing && displayName === undefined) {
        return res.status(400).json({
          error: "displayName is required when first naming a drive",
        });
      }
      const drive = await prisma.drive.upsert({
        where: { uuid },
        create: {
          uuid,
          displayName: displayName!,
          icon: icon ?? null,
          notes: notes ?? null,
        },
        update: {
          ...(displayName !== undefined ? { displayName } : {}),
          ...(icon !== undefined ? { icon } : {}),
          ...(notes !== undefined ? { notes } : {}),
        },
      });
      res.json(drive);
    } catch (err) {
      logger.warn({ err, uuid: req.params.uuid }, "Failed to update Drive label");
      next(err);
    }
  });

  return router;
}
