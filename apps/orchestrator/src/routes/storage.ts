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

// WARP-612: shared secret the device-bridge requires on mutating routes
// (eject). Mirrors the bridge's own env precedence. Read per-request (see the
// eject handler) so a deployment that injects the secret after boot — and the
// tests — see the current value rather than a boot-time snapshot.
function bridgeAuthToken(): string {
  return (
    process.env.BRIDGE_AUTH_TOKEN ||
    process.env.SERVICE_TOKEN_DISPLAY ||
    ""
  ).trim();
}

interface BridgeDrive {
  device: string;
  mount: string;
  label: string;
  uuid: string;
  size_bytes: number;
  used_bytes: number;
  free_bytes: number;
  mounted: boolean;
  /** WARP-612: read-only enrichment from the device-bridge. Optional so an
   *  older bridge that predates the enrichment still type-checks; `bus` is
   *  re-derived server-side (deriveBus) when the bridge omits it. */
  fs?: string;
  bus?: string;
  readonly?: boolean;
  /** WARP-612: SMART health ("PASSED"/"FAILED") + temperature °C. Present
   *  only when the bridge has DRIVE_SMART_ENABLED and smartctl can read the
   *  device; null/absent otherwise. The dashboard hides the chips when null. */
  smart?: string | null;
  temp_c?: number | null;
  /** WARP-612: hot-plug auto-mounted (ejectable) vs installed/fstab — the
   *  bus-agnostic ejectability signal (ADR-011). The UI shows Eject on this,
   *  not on bus. */
  removable?: boolean;
}

/** Fallback bus class for the icon when the bridge omits `bus` (older bridge).
 *  The bridge sends the *real* transport (it reads lsblk on the host); the
 *  orchestrator runs in a container without the host's block devices, so it
 *  can only name-guess. Stay neutral for sd* rather than guessing 'usb' — a
 *  /dev/sd* drive is just as likely SATA/SAS (ADR-011). Presentation-only. */
function deriveBus(device: string): string {
  const base = (device || "").split("/").pop() || "";
  if (base.startsWith("nvme")) return "nvme";
  if (base.startsWith("mmcblk")) return "mmc";
  return "disk";
}

/**
 * The device-bridge only runs with the OLED/display compose profile. On a host
 * without it, the fetch fails with ECONNREFUSED ("fetch failed" + a
 * `cause.code` of ECONNREFUSED/ENOTFOUND/etc.). That's an EXPECTED condition —
 * not an error — so we degrade cleanly (200 + `reason: "bridge_unavailable"`)
 * and log at info level rather than warn/error. Real failures (a reachable
 * bridge that times out or returns garbage) still log louder.
 */
function isBridgeConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const codes = new Set([
    "ECONNREFUSED",
    "ENOTFOUND",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EAI_AGAIN",
  ]);
  // Node's undici wraps the socket error in `cause`; older paths put the code
  // directly on the error. Check both.
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause?.code && codes.has(cause.code)) return true;
  const directCode = (err as { code?: string }).code;
  if (directCode && codes.has(directCode)) return true;
  return false;
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
          // Guarantee a bus class for the dashboard even if the bridge is
          // older than the WARP-612 enrichment.
          bus: d.bus ?? deriveBus(d.device),
          displayName: label?.displayName ?? null,
          icon: label?.icon ?? null,
          notes: label?.notes ?? null,
        };
      });

      res.json({ drives, count: snap.count, snapshot_at: snap.snapshot_at });
    } catch (err) {
      // The device-bridge is optional (OLED/display profile only). A
      // connection refusal means it simply isn't running on this host — an
      // expected deployment shape, not an error. Degrade cleanly: 200 with an
      // empty drive list and a typed reason the dashboard can branch on.
      if (isBridgeConnectionError(err)) {
        logger.info(
          { bridgeUrl: BRIDGE_URL },
          "device-bridge not reachable; reporting no drives (bridge_unavailable)",
        );
        res.json({ drives: [], count: 0, reason: "bridge_unavailable" });
        return;
      }
      // A reachable-but-misbehaving bridge (timeout, bad JSON, etc.) is a real
      // problem worth a louder log; still return the 200 empty shape so the
      // dashboard renders.
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

  /**
   * POST /api/storage/drives/rescan — refresh the device-bridge's drive
   * snapshot (it caches ~10s). Proxies the bridge's existing
   * `/drives/changed` cache-invalidation hook — the same one the automount
   * udev rule calls on hot-plug — so this only drops a cache; it never
   * mounts or unmounts. Admin-only because it's a device-control action.
   */
  router.post("/storage/drives/rescan", async (req, res) => {
    if (!isAdmin(req)) {
      return res.status(403).json({ error: "Admin access required" });
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(`${BRIDGE_URL}/drives/changed`, {
        method: "POST",
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) {
        return res.status(502).json({ ok: false, error: `bridge returned ${r.status}` });
      }
      return res.json({ ok: true });
    } catch (err) {
      // The device-bridge is optional (OLED/display profile only). A connection
      // refusal means it simply isn't running on this host — degrade cleanly
      // with a typed reason instead of leaking the raw "fetch failed" string.
      if (isBridgeConnectionError(err)) {
        logger.warn({ err }, "device-bridge not reachable (bridge_unavailable)");
        return res.status(503).json({
          ok: false,
          reason: "bridge_unavailable",
          error: "The storage service isn't reachable right now.",
        });
      }
      logger.warn({ err }, "Failed to trigger drive rescan");
      return res
        .status(502)
        .json({ ok: false, error: (err as Error).message || "bridge unreachable" });
    }
  });

  /**
   * POST /api/storage/drives/:uuid/eject — unmount + forget a hot-plug
   * auto-mounted drive (WARP-612). Admin-only. Forwards to the device-bridge's
   * auth-gated /drives/:uuid/eject, which gates on automount-state membership +
   * a /mnt/droplet/ mount (bus-agnostic per ADR-011 — USB, external NVMe, SD,
   * SATA dock, etc.), not on bus type. Requires a bridge auth token; 503 if the
   * deployment hasn't provisioned one. A 409 (drive busy) is surfaced so the
   * user can close files and retry; other bridge errors return a generic
   * message and are logged server-side.
   */
  router.post("/storage/drives/:uuid/eject", async (req, res) => {
    if (!isAdmin(req)) {
      return res.status(403).json({ error: "Admin access required" });
    }
    const { uuid } = req.params;
    if (!/^[A-Za-z0-9:-]{1,64}$/.test(uuid)) {
      return res.status(400).json({ error: "Invalid drive UUID" });
    }
    const bridgeToken = bridgeAuthToken();
    if (!bridgeToken) {
      return res.status(503).json({
        ok: false,
        error: "Drive eject is unavailable — the device-bridge auth token is not configured.",
      });
    }
    try {
      const ctrl = new AbortController();
      // The bridge's eject runs sync (≤10s) + umount (≤20s) = ~30s worst case,
      // so wait longer than that: aborting at 25s would 502 an eject the bridge
      // actually completed, leaving the user retrying an already-unmounted drive.
      const timer = setTimeout(() => ctrl.abort(), 35000);
      const r = await fetch(`${BRIDGE_URL}/drives/${encodeURIComponent(uuid)}/eject`, {
        method: "POST",
        headers: { "X-Droplet-Auth": bridgeToken },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        // Log the bridge's raw message server-side; only the 409 "busy" case is
        // actionable enough to surface (and bridge errors can carry mount
        // internals, so other statuses get a generic message).
        logger.warn({ uuid, status: r.status, bridgeError: body.error }, "Drive eject rejected by bridge");
        return res.status(r.status === 409 ? 409 : 502).json({
          ok: false,
          error:
            r.status === 409
              ? body.error || "The drive is in use — close any open files and try again."
              : "The device-bridge could not complete the eject.",
        });
      }
      return res.json({ ok: true });
    } catch (err) {
      // The device-bridge is optional (OLED/display profile only). A connection
      // refusal means it simply isn't running on this host — degrade cleanly
      // with a typed reason instead of leaking the raw "fetch failed" string.
      if (isBridgeConnectionError(err)) {
        logger.warn({ err, uuid }, "device-bridge not reachable (bridge_unavailable)");
        return res.status(503).json({
          ok: false,
          reason: "bridge_unavailable",
          error: "The storage service isn't reachable right now.",
        });
      }
      logger.warn({ err, uuid }, "Failed to eject drive");
      return res
        .status(502)
        .json({ ok: false, error: (err as Error).message || "bridge unreachable" });
    }
  });

  return router;
}
