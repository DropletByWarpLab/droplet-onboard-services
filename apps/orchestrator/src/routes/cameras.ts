/**
 * Camera API routes — listing, snapshots, events, discovery, and SSE notifications.
 *
 * All camera streams and snapshots are proxied through these authenticated
 * endpoints so camera IPs are never exposed to external clients. Works
 * identically on-LAN and off-LAN via the Nginx HTTPS gateway.
 *
 * ROUTE ORDERING: All fixed-path routes (/cameras/events/*, /cameras/discovered,
 * /cameras/stats, /cameras/drivers) MUST be registered before parameterized
 * routes (/cameras/:name) to avoid shadowing.
 */

import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import pino from "pino";
import {
  getCameras,
  getEventsFiltered,
  getRecentEvents,
  getRecordings,
  getRecordingsSummary,
  getReviewsFiltered,
  getStats,
  getTimelineEntries,
  setEventRetention,
  setReviewViewed,
  subscribeCameraEvents,
  isInitialized,
} from "../services/camera.service.js";
import {
  fetchSnapshot,
  fetchEventThumbnail,
  openBirdseyeStream,
  openMjpegStream,
  enableDetection,
  disableDetection,
  deleteCamera,
  addCamera,
  fetchEvents,
  buildRecordingClipUrl,
  buildVodMasterUrl,
  buildVodSegmentUrl,
  fetchHlsPlaylist,
  fetchPtzCapabilities,
  ptzGoToPreset,
  ptzMove,
  restartFrigate,
  type PtzAction,
} from "../services/frigate.client.js";
import { getCameraSystemStatus } from "../services/camera-system.service.js";
import { Readable } from "node:stream";
import { config } from "../config.js";
import { evaluateNetworkCommand } from "../services/network-safety.service.js";
import { exportClip, signShareUrl, verifyShareUrl } from "../services/clips.service.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";
import { ncDownloadFile } from "../services/nextcloud.client.js";
import * as groupsSvc from "../services/camera-groups.service.js";
import {
  isValidGroupName,
  isValidGroupIcon,
} from "../services/camera-groups.service.js";
import * as pinsSvc from "../services/camera-pins.service.js";
import {
  getCameraSettings,
  updateCameraSettings,
  type CameraSettingsPatch,
} from "../services/camera-settings.service.js";
import { z } from "zod";

const logger = pino({ name: "cameras-routes" });

/** Service-to-service auth headers for routing/discovery services. */
function serviceAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.SERVICE_SECRET) {
    headers["Authorization"] = `Bearer ${config.SERVICE_SECRET}`;
  }
  return headers;
}

// --- Input validation helpers ---

/** Camera names: alphanumeric, underscores, hyphens only (Frigate convention) */
const CAMERA_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Frigate event IDs: alphanumeric with hyphens/dots (UUID-like or numeric) */
const EVENT_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;

function isValidCameraName(name: string): boolean {
  return CAMERA_NAME_RE.test(name);
}

function isValidEventId(id: string): boolean {
  return EVENT_ID_RE.test(id);
}

export function createCamerasRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ==========================================================================
  // FIXED-PATH ROUTES (must be registered before :name parameterized routes)
  // ==========================================================================

  // --- Camera groups ---
  //
  // Operator-defined logical groupings rendered as a navigation rail above
  // the cameras grid. Membership is many-to-many via CameraGroupMember;
  // see services/camera-groups.service.ts for the data model + DTO shape.
  //
  // Routes are registered before /cameras/:name for the same reason as the
  // clips routes below: parameterized :name would otherwise shadow
  // /cameras/groups and resolve as a camera literally named "groups".

  router.get("/cameras/groups", async (_req, res, next) => {
    try {
      const groups = await groupsSvc.listGroups(prisma);
      res.json({ groups });
    } catch (err) {
      next(err);
    }
  });

  router.post("/cameras/groups", async (req, res, next) => {
    try {
      const { name, icon, cameraNames } = req.body ?? {};
      if (!isValidGroupName(name)) {
        return res.status(400).json({ error: "Invalid group name" });
      }
      if (!isValidGroupIcon(icon)) {
        return res.status(400).json({ error: "Invalid group icon" });
      }
      if (
        cameraNames !== undefined &&
        (!Array.isArray(cameraNames) ||
          cameraNames.some((s) => typeof s !== "string" || !isValidCameraName(s)))
      ) {
        return res.status(400).json({ error: "cameraNames must be a list of camera names" });
      }
      const group = await groupsSvc.createGroup(prisma, {
        name,
        icon: icon ?? null,
        cameraNames: cameraNames as string[] | undefined,
      });
      res.status(201).json({ group });
    } catch (err) {
      // Unique constraint on name → 409 with a friendly message
      if ((err as { code?: string })?.code === "P2002") {
        return res.status(409).json({ error: "A group with that name already exists" });
      }
      next(err);
    }
  });

  router.patch("/cameras/groups/:id", async (req, res, next) => {
    try {
      const { name, icon, sortOrder } = req.body ?? {};
      if (name !== undefined && !isValidGroupName(name)) {
        return res.status(400).json({ error: "Invalid group name" });
      }
      if (icon !== undefined && !isValidGroupIcon(icon)) {
        return res.status(400).json({ error: "Invalid group icon" });
      }
      if (
        sortOrder !== undefined &&
        (typeof sortOrder !== "number" || !Number.isFinite(sortOrder))
      ) {
        return res.status(400).json({ error: "sortOrder must be a number" });
      }
      const group = await groupsSvc.updateGroup(prisma, req.params.id, {
        name,
        icon,
        sortOrder,
      });
      if (!group) return res.status(404).json({ error: "Group not found" });
      res.json({ group });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") {
        return res.status(409).json({ error: "A group with that name already exists" });
      }
      next(err);
    }
  });

  router.delete("/cameras/groups/:id", async (req, res, next) => {
    try {
      const ok = await groupsSvc.deleteGroup(prisma, req.params.id);
      if (!ok) return res.status(404).json({ error: "Group not found" });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.post("/cameras/groups/:id/members", async (req, res, next) => {
    try {
      const { cameraNames } = req.body ?? {};
      if (
        !Array.isArray(cameraNames) ||
        cameraNames.some((s) => typeof s !== "string" || !isValidCameraName(s))
      ) {
        return res
          .status(400)
          .json({ error: "cameraNames must be a list of camera names" });
      }
      const group = await groupsSvc.addMembers(
        prisma,
        req.params.id,
        cameraNames,
      );
      if (!group) return res.status(404).json({ error: "Group not found" });
      res.json({ group });
    } catch (err) {
      next(err);
    }
  });

  router.delete(
    "/cameras/groups/:id/members/:cameraName",
    async (req, res, next) => {
      try {
        if (!isValidCameraName(req.params.cameraName)) {
          return res.status(400).json({ error: "Invalid camera name" });
        }
        const group = await groupsSvc.removeMember(
          prisma,
          req.params.id,
          req.params.cameraName,
        );
        if (!group) return res.status(404).json({ error: "Group not found" });
        res.json({ group });
      } catch (err) {
        next(err);
      }
    },
  );

  // --- Camera pins ---
  //
  // Per-user "pinned" cameras — an operator preference that lifts the
  // cameras they actually watch above the alphabetical grid. Pins are
  // keyed on userId + cameraName (Frigate camera name) rather than a
  // Camera FK because they're pure prefs: if the underlying camera
  // disappears we filter the dangling pin on read instead of cascading
  // deletes. See services/camera-pins.service.ts for rationale.
  //
  // Route ordering: /cameras/pins/reorder is registered before
  // /cameras/pins/:cameraName so the literal path matches first; both
  // also live above /cameras/:name for the standard fixed-vs-param
  // shadowing reason called out in the file header.

  router.get("/cameras/pins", async (req, res, next) => {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const pins = await pinsSvc.listPins(prisma, req.user.id);
      res.json({ pins });
    } catch (err) {
      next(err);
    }
  });

  router.post("/cameras/pins", async (req, res, next) => {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const { cameraName } = req.body ?? {};
      if (typeof cameraName !== "string" || !isValidCameraName(cameraName)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const pin = await pinsSvc.addPin(prisma, req.user.id, cameraName);
      res.status(201).json({ pin });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/cameras/pins/reorder", async (req, res, next) => {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const { cameraNames } = req.body ?? {};
      if (
        !Array.isArray(cameraNames) ||
        cameraNames.some(
          (s) => typeof s !== "string" || !isValidCameraName(s),
        )
      ) {
        return res
          .status(400)
          .json({ error: "cameraNames must be a list of camera names" });
      }
      const pins = await pinsSvc.reorderPins(
        prisma,
        req.user.id,
        cameraNames,
      );
      res.json({ pins });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/cameras/pins/:cameraName", async (req, res, next) => {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ error: "Authentication required" });
      }
      if (!isValidCameraName(req.params.cameraName)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      await pinsSvc.removePin(prisma, req.user.id, req.params.cameraName);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // --- Clips (PR #3) ---
  //
  // These MUST come before /cameras/:name. Otherwise Express routes
  // GET /cameras/clips to the :name handler with name="clips" and the LLM
  // tool list_clips silently returns a single "camera" record.

  router.get("/cameras/clips", async (req, res, next) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const camera = req.query.camera as string | undefined;
      if (camera && !isValidCameraName(camera)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const events = (await fetchEvents(limit, camera)) as Array<Record<string, unknown>>;
      const clips = events
        .filter((e) => e.has_clip === true)
        .map((e) => ({
          id: e.id,
          camera: e.camera,
          label: e.label,
          score: e.score,
          start_time: e.start_time,
          end_time: e.end_time,
          thumbnail_url: `/api/cameras/events/${encodeURIComponent(String(e.id))}/thumbnail`,
          clip_url: `/api/cameras/clips/event/${encodeURIComponent(String(e.id))}`,
        }));
      res.json({ clips });
    } catch (err) {
      next(err);
    }
  });

  router.get("/cameras/clips/event/:eventId", async (req, res, next) => {
    try {
      if (!isValidEventId(req.params.eventId)) {
        return res.status(400).json({ error: "Invalid event id" });
      }
      const url = `${config.FRIGATE_URL}/api/events/${encodeURIComponent(req.params.eventId)}/clip.mp4`;
      const upstream = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!upstream.ok) {
        return res.status(upstream.status).json({ error: `frigate ${upstream.status}` });
      }
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "video/mp4");
      const len = upstream.headers.get("content-length");
      if (len) res.setHeader("Content-Length", len);
      if (upstream.body) {
        const { Readable } = await import("node:stream");
        Readable.fromWeb(upstream.body as never).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      next(err);
    }
  });

  router.post("/cameras/clips/share", async (req, res, next) => {
    try {
      const schema = z.object({
        nc_path: z.string().min(1).max(2048),
        ttl_minutes: z.number().int().min(1).max(1440).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      }
      const userId = req.user?.username;
      if (!userId) return res.status(401).json({ error: "unauthenticated" });

      // Defense-in-depth path check — mirrors PR #1's validateNcPath logic so
      // a caller can't sign a token whose ncPath traverses out of their own
      // Nextcloud namespace. Whether Sabre/DAV would also reject is immaterial
      // — we don't want to rely on it.
      const pathValid = isSafeNcPath(parsed.data.nc_path);
      if (!pathValid.ok) {
        return res.status(400).json({ error: pathValid.error });
      }

      const ttlSec = (parsed.data.ttl_minutes ?? 60) * 60;
      const token = signShareUrl(userId, pathValid.path, ttlSec);
      const filename = pathValid.path.split("/").pop() ?? "clip.mp4";
      res.json({
        url: `/api/cameras/clips/share/${encodeURIComponent(filename)}?t=${encodeURIComponent(token)}`,
        expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  // --- Birdseye live (Phase 6.2) ---
  //
  // Frigate's auto-composited multi-camera MJPEG stream. Cameras with
  // current motion get foregrounded automatically; the operator gets
  // a single "what's happening anywhere?" feed without paying for
  // every camera's bandwidth.
  //
  // Fixed path because /cameras/birdseye/live has 3 segments — adding
  // it here keeps it next to the system route which has the same
  // ordering rationale.

  router.get("/cameras/birdseye/live", async (req, res, next) => {
    try {
      const ctrl = new AbortController();
      req.on("close", () => ctrl.abort());
      const upstream = await openBirdseyeStream(ctrl.signal);
      const contentType =
        upstream.headers.get("content-type") ||
        "multipart/x-mixed-replace;boundary=frame";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Connection", "close");
      if (!upstream.body) {
        return res.status(502).json({ error: "Frigate returned no body" });
      }
      Readable.fromWeb(upstream.body as never).pipe(res);
    } catch (err) {
      // Birdseye is optional — Frigate returns 404 if no camera is
      // configured for birdseye output. Surface that as a clean 404
      // so the dashboard can show "Birdseye not configured."
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("404")) {
        return res
          .status(404)
          .json({ error: "Birdseye not enabled in Frigate config" });
      }
      next(err);
    }
  });

  // --- System status (Phase 5) ---
  //
  // Typed wrapper around Frigate's /api/stats + /api/version. The raw
  // /cameras/stats route below stays — it's the LLM tool's escape
  // hatch for the full payload. This one is what the dashboard's
  // /cameras/system page renders.
  //
  // Registered in the fixed-path section because `/cameras/system`
  // (2 path segments after /api) would otherwise be matched by
  // `/cameras/:name` with name="system".

  router.get("/cameras/system", async (_req, res, next) => {
    try {
      const status = await getCameraSystemStatus();
      res.json({ status });
    } catch (err) {
      next(err);
    }
  });

  router.post("/cameras/system/restart", async (req, res, next) => {
    try {
      // Restart is destructive (every camera goes dark for ~10s) so we
      // gate it behind the network-command tier-2 confirmation flow.
      // Same pattern as camera disable/delete.
      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma,
        "frigate.system",
        "restart_frigate",
        {},
        userId,
      );
      if ("blocked" in result && result.blocked) {
        return res
          .status(429)
          .json({ error: result.reason, tier: result.tier, blocked: true });
      }
      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          confirmationToken: result.confirmationToken,
          reason: result.reason,
          tier: result.tier,
          expiresIn: 60,
        });
      }
      await restartFrigate();
      res.json({ status: "restarting" });
    } catch (err) {
      next(err);
    }
  });

  // --- List all cameras ---
  router.get("/cameras", async (_req, res, next) => {
    try {
      if (!isInitialized()) {
        return res.json({ cameras: [], _status: "disconnected" });
      }
      const cameras = await getCameras(prisma);
      res.json({ cameras });
    } catch (err) {
      next(err);
    }
  });

  // --- Manually add a camera (name + RTSP URL) ---
  router.post("/cameras", async (req, res, next) => {
    try {
      const { name, rtspUrl, manufacturer, model } = req.body;
      if (!name || typeof name !== "string" || !isValidCameraName(name)) {
        return res.status(400).json({ error: "Invalid camera name (alphanumeric + underscores/hyphens, 1-64 chars)" });
      }
      if (!rtspUrl || typeof rtspUrl !== "string") {
        return res.status(400).json({ error: "Missing rtspUrl" });
      }
      if (!/^rtsps?:\/\/.+/.test(rtspUrl)) {
        return res.status(400).json({ error: "rtspUrl must start with rtsp:// or rtsps://" });
      }

      // Add to Frigate
      const success = await addCamera(name, rtspUrl);
      if (!success) {
        return res.status(500).json({ error: "Failed to add camera to Frigate" });
      }

      // Upsert DB record
      const displayName = name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      await prisma.camera.upsert({
        where: { name },
        create: {
          name,
          displayName,
          manufacturer: manufacturer || null,
          model: model || null,
          ipAddress: new URL(rtspUrl.replace("rtsp://", "http://").replace("rtsps://", "https://")).hostname || "",
          enabled: true,
          autoDiscovered: false,
          lastSeen: new Date(),
        },
        update: {
          displayName,
          manufacturer: manufacturer || undefined,
          model: model || undefined,
          enabled: true,
          lastSeen: new Date(),
        },
      });

      res.json({ status: "ok", camera: name });
    } catch (err) {
      next(err);
    }
  });

  // --- Trigger a discovery scan ---
  router.post("/cameras/scan", async (_req, res) => {
    try {
      const resp = await fetch(`${config.CAMERA_DISCOVERY_URL}/scan`, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) {
        return res.status(resp.status).json({ error: "Scan failed" });
      }
      res.json(await resp.json());
    } catch {
      // Camera-discovery service may not be running (it's in full profile)
      res.json({
        status: "scan_unavailable",
        message: "Camera discovery service is not running. Start it with: docker compose --profile full up camera-discovery",
      });
    }
  });

  // --- Filtered events listing (Events page, Phase 2) ---
  //
  // Cursor pagination: the dashboard passes back the smallest
  // `start_time` from the previous page as `before`. The route returns
  // `nextCursor` (number | null) so the client doesn't have to recompute
  // it. Limit is clamped at 200; Frigate accepts up to 1000 but the
  // dashboard's grid renders ~50 comfortably.
  //
  // Filters: `cameras` (csv), `labels` (csv), `min_score`, `before`,
  // `after`, `has_clip`, `has_snapshot`. Anything not supplied is
  // ignored. Camera names + label strings are validated; numeric fields
  // are checked for finiteness.
  router.get("/cameras/events", async (req, res, next) => {
    try {
      const q = req.query as Record<string, string | undefined>;

      // Validate cameras csv
      let cameras: string[] | undefined;
      if (q.cameras) {
        cameras = q.cameras.split(",").map((s) => s.trim()).filter(Boolean);
        if (cameras.some((c) => !isValidCameraName(c))) {
          return res.status(400).json({ error: "Invalid camera name in cameras param" });
        }
      }

      // Validate labels csv (Frigate labels are lowercase alphanumeric +
      // underscore; cap length defensively).
      let labels: string[] | undefined;
      if (q.labels) {
        labels = q.labels.split(",").map((s) => s.trim()).filter(Boolean);
        if (labels.some((l) => !/^[a-z0-9_-]{1,32}$/i.test(l))) {
          return res.status(400).json({ error: "Invalid label in labels param" });
        }
      }

      const numOrUndef = (v: string | undefined): number | undefined => {
        if (v === undefined) return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };
      const boolOrUndef = (v: string | undefined): boolean | undefined => {
        if (v === undefined) return undefined;
        if (v === "1" || v === "true") return true;
        if (v === "0" || v === "false") return false;
        return undefined;
      };

      const minScore = numOrUndef(q.min_score);
      if (minScore !== undefined && (minScore < 0 || minScore > 1)) {
        return res.status(400).json({ error: "min_score must be between 0 and 1" });
      }

      const limitRaw = parseInt(q.limit || "50", 10);
      const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), 200);

      const result = await getEventsFiltered({
        cameras,
        labels,
        minScore,
        before: numOrUndef(q.before),
        after: numOrUndef(q.after),
        hasClip: boolOrUndef(q.has_clip),
        hasSnapshot: boolOrUndef(q.has_snapshot),
        limit,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // --- Retain-indefinitely toggle (Phase 2.2) ---
  //
  // POST { retain: boolean } — sets or clears the Frigate-side
  // `retain_indefinitely` flag on an event. Operators use this to mark
  // an event "Saved" so the cluster doesn't get swept during the next
  // retention pass. Idempotent on Frigate's end. Returns 204 since the
  // dashboard already has the event DTO and just needs to flip the
  // boolean locally on success.
  router.post("/cameras/events/:eventId/retain", async (req, res, next) => {
    try {
      if (!isValidEventId(req.params.eventId)) {
        return res.status(400).json({ error: "Invalid event ID format" });
      }
      const retain = req.body?.retain;
      if (typeof retain !== "boolean") {
        return res.status(400).json({ error: "retain must be a boolean" });
      }
      await setEventRetention(req.params.eventId, retain);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // --- Reviews (Frigate 0.13+ severity-grouped clusters) ---
  //
  // Same filter shape as /cameras/events but the unit is a Review item
  // (cluster) rather than an event. Severity values are validated to a
  // small allow-list — Frigate's wire string is mirrored back, but
  // anything outside `alert | detection | significant_motion` is
  // treated as a 400 to keep us from silently dropping unknown
  // severities into the SQL filter.
  //
  // Cursor pagination is identical to the events route (`before` =
  // smallest start_time of the previous page).
  router.get("/cameras/reviews", async (req, res, next) => {
    try {
      const q = req.query as Record<string, string | undefined>;

      let cameras: string[] | undefined;
      if (q.cameras) {
        cameras = q.cameras.split(",").map((s) => s.trim()).filter(Boolean);
        if (cameras.some((c) => !isValidCameraName(c))) {
          return res.status(400).json({ error: "Invalid camera name in cameras param" });
        }
      }

      let severity: string[] | undefined;
      if (q.severity) {
        severity = q.severity.split(",").map((s) => s.trim()).filter(Boolean);
        const allowed = new Set(["alert", "detection", "significant_motion"]);
        if (severity.some((s) => !allowed.has(s))) {
          return res.status(400).json({ error: "Invalid severity (allowed: alert, detection, significant_motion)" });
        }
      }

      const numOrUndef = (v: string | undefined): number | undefined => {
        if (v === undefined) return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };
      const boolOrUndef = (v: string | undefined): boolean | undefined => {
        if (v === undefined) return undefined;
        if (v === "1" || v === "true") return true;
        if (v === "0" || v === "false") return false;
        return undefined;
      };

      const limitRaw = parseInt(q.limit || "50", 10);
      const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), 200);

      const result = await getReviewsFiltered({
        cameras,
        severity,
        before: numOrUndef(q.before),
        after: numOrUndef(q.after),
        reviewed: boolOrUndef(q.reviewed),
        limit,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /** Frigate review IDs are UUID-ish — looser than event IDs but bound
   *  to the same character class. Same regex serves both. */
  router.post("/cameras/reviews/:reviewId/viewed", async (req, res, next) => {
    try {
      if (!isValidEventId(req.params.reviewId)) {
        return res.status(400).json({ error: "Invalid review ID format" });
      }
      await setReviewViewed(req.params.reviewId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Review preview clip (Frigate-rendered cluster summary mp4).
  router.get("/cameras/reviews/:reviewId/preview", async (req, res, next) => {
    try {
      if (!isValidEventId(req.params.reviewId)) {
        return res.status(400).json({ error: "Invalid review ID format" });
      }
      const url = `${config.FRIGATE_URL}/api/review/${encodeURIComponent(req.params.reviewId)}/preview.mp4`;
      const upstream = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!upstream.ok) {
        return res.status(upstream.status).json({ error: `frigate ${upstream.status}` });
      }
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "video/mp4");
      const len = upstream.headers.get("content-length");
      if (len) res.setHeader("Content-Length", len);
      if (upstream.body) {
        Readable.fromWeb(upstream.body as never).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      next(err);
    }
  });

  // Review thumbnail.
  router.get("/cameras/reviews/:reviewId/thumbnail", async (req, res, next) => {
    try {
      if (!isValidEventId(req.params.reviewId)) {
        return res.status(400).json({ error: "Invalid review ID format" });
      }
      const url = `${config.FRIGATE_URL}/api/review/${encodeURIComponent(req.params.reviewId)}/thumbnail.jpg`;
      const upstream = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!upstream.ok) {
        return res.status(upstream.status).json({ error: `frigate ${upstream.status}` });
      }
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=3600");
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  });

  // --- Event snapshot (proxied from Frigate) ---
  //
  // Companion to the existing thumbnail route — returns the full-resolution
  // saved snapshot for events with `has_snapshot=true`. The events page
  // shows this in the playback modal alongside the clip when no clip was
  // recorded.
  router.get("/cameras/events/:eventId/snapshot", async (req, res, next) => {
    try {
      if (!isValidEventId(req.params.eventId)) {
        return res.status(400).json({ error: "Invalid event ID format" });
      }
      const url = `${config.FRIGATE_URL}/api/events/${encodeURIComponent(req.params.eventId)}/snapshot.jpg`;
      const upstream = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!upstream.ok) {
        return res.status(upstream.status).json({ error: `frigate ${upstream.status}` });
      }
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=3600");
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  });

  // --- SSE stream for real-time events ---
  router.get("/cameras/events/sse", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

    const heartbeat = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 30_000);

    const unsubscribe = subscribeCameraEvents((event) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Client may have disconnected
      }
    });

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // --- Recent events across all cameras ---
  router.get("/cameras/events/recent", async (req, res, next) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const events = await getRecentEvents(limit);
      res.json({ events });
    } catch (err) {
      next(err);
    }
  });

  // --- Event thumbnail (proxied from Frigate) ---
  router.get("/cameras/events/:eventId/thumbnail", async (req, res, next) => {
    try {
      if (!isValidEventId(req.params.eventId)) {
        return res.status(400).json({ error: "Invalid event ID format" });
      }
      const frigateResp = await fetchEventThumbnail(req.params.eventId);
      const contentType = frigateResp.headers.get("content-type") || "image/jpeg";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=3600");
      const buffer = Buffer.from(await frigateResp.arrayBuffer());
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  });

  // --- Discovered cameras (pending acceptance) ---
  router.get("/cameras/discovered", async (_req, res, next) => {
    try {
      const pending = await prisma.camera.findMany({
        where: { enabled: false, autoDiscovered: true },
        orderBy: { createdAt: "desc" },
      });
      res.json(
        pending.map((c) => ({
          id: c.id,
          name: c.name,
          ip: c.ipAddress,
          mac: c.macAddress,
          manufacturer: c.manufacturer,
          model: c.model,
          discoveredAt: c.createdAt.toISOString(),
        }))
      );
    } catch (err) {
      next(err);
    }
  });

  // --- Accept a discovered camera ---
  router.post("/cameras/discovered/:id/accept", async (req, res, next) => {
    try {
      const camera = await prisma.camera.update({
        where: { id: req.params.id },
        data: { enabled: true },
      });
      res.json({ status: "accepted", camera: camera.name });
    } catch (err) {
      next(err);
    }
  });

  // --- Reject a discovered camera ---
  router.post("/cameras/discovered/:id/reject", async (req, res, next) => {
    try {
      await prisma.camera.delete({ where: { id: req.params.id } });
      res.json({ status: "rejected" });
    } catch (err) {
      next(err);
    }
  });

  // --- Frigate system stats ---
  router.get("/cameras/stats", async (_req, res, next) => {
    try {
      const stats = await getStats();
      res.json(stats);
    } catch (err) {
      next(err);
    }
  });

  // --- Driver status (proxied from camera-discovery service) ---
  router.get("/cameras/drivers", async (_req, res) => {
    try {
      const resp = await fetch(`${config.CAMERA_DISCOVERY_URL}/drivers`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        return res.status(resp.status).json({ error: "Driver check failed" });
      }
      const data = await resp.json();
      res.json(data);
    } catch {
      res.json({
        health: "unknown",
        summary: { note: "Camera discovery service not reachable" },
        kernel_modules: [],
        video_devices: [],
        usb_cameras: [],
        tools: [],
      });
    }
  });

  router.post("/cameras/drivers/fix", async (_req, res, next) => {
    try {
      // Forward DEVICE_SECRET for authentication (the discovery service
      // requires it for kernel module operations like modprobe)
      const headers: Record<string, string> = {};
      const deviceSecret = process.env.DEVICE_SECRET_KEY || process.env.DEVICE_SECRET || "";
      if (deviceSecret) {
        headers["Authorization"] = `Bearer ${deviceSecret}`;
      }

      const resp = await fetch(`${config.CAMERA_DISCOVERY_URL}/drivers/fix`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        return res.status(resp.status).json({ error: "Driver fix failed" });
      }
      const data = await resp.json();
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // --- Camera subnet isolation ---
  router.get("/cameras/subnet", async (_req, res) => {
    try {
      const resp = await fetch(`${config.ROUTING_SERVICE_URL}/network/subnets/cameras`, {
        headers: serviceAuthHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        return res.json({ enabled: false, error: "Router not reachable" });
      }
      res.json(await resp.json());
    } catch {
      res.json({ enabled: false, error: "Routing service not reachable" });
    }
  });

  router.post("/cameras/subnet/setup", async (req, res, next) => {
    try {
      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, "camera.subnet", "camera_subnet_setup", req.body || {}, userId
      );
      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }
      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          confirmationToken: result.confirmationToken,
          reason: result.reason,
          tier: result.tier,
          expiresIn: 60,
        });
      }

      const body = req.body || {};
      const resp = await fetch(`${config.ROUTING_SERVICE_URL}/network/subnets/cameras/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...serviceAuthHeaders() },
        body: JSON.stringify({
          vlan_id: body.vlanId || 100,
          subnet: body.subnet || "192.168.100.1",
          netmask: body.netmask || "255.255.255.0",
          dhcp_start: body.dhcpStart || 100,
          dhcp_limit: body.dhcpLimit || 150,
          leasetime: body.leasetime || "12h",
        }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await resp.json();
      if (!resp.ok) {
        return res.status(resp.status).json(data);
      }
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/cameras/subnet", async (req, res, next) => {
    try {
      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, "camera.subnet", "camera_subnet_teardown", {}, userId
      );
      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }
      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          confirmationToken: result.confirmationToken,
          reason: result.reason,
          tier: result.tier,
          expiresIn: 60,
        });
      }

      const resp = await fetch(`${config.ROUTING_SERVICE_URL}/network/subnets/cameras`, {
        method: "DELETE",
        headers: serviceAuthHeaders(),
        signal: AbortSignal.timeout(30000),
      });
      const data = await resp.json();
      if (!resp.ok) {
        return res.status(resp.status).json(data);
      }
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // ==========================================================================
  // PARAMETERIZED ROUTES (/cameras/:name) — must come AFTER all fixed paths
  // ==========================================================================

  // --- Single camera details ---
  router.get("/cameras/:name", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const cameras = await getCameras(prisma);
      const camera = cameras.find((c) => c.name === req.params.name);
      if (!camera) {
        return res.status(404).json({ error: "Camera not found" });
      }

      const events = await getRecentEvents(5, req.params.name);
      res.json({ ...camera, recentEvents: events });
    } catch (err) {
      next(err);
    }
  });

  // --- Camera live MJPEG stream (proxied from Frigate — auth-gated) ---
  //
  // Frigate serves a multipart `Content-Type: multipart/x-mixed-replace`
  // stream at `/api/{name}` that any browser will render natively in an
  // <img> as a continuous video feed. Snapshots are good enough for the
  // grid-card thumbnails; this is the path the detail panel uses to give
  // the user a real live view without leaving the Droplet UI.
  //
  // The body has to be piped, not buffered — the stream never EOFs while
  // the camera is up. We hook AbortController to req.close so closing the
  // browser tab unwinds the upstream fetch instead of leaking sockets.
  router.get("/cameras/:name/live", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const ctrl = new AbortController();
      req.on("close", () => ctrl.abort());
      const frigateResp = await openMjpegStream(req.params.name, ctrl.signal);
      const contentType =
        frigateResp.headers.get("content-type") ||
        "multipart/x-mixed-replace;boundary=frame";
      res.setHeader("Content-Type", contentType);
      // The stream is live — never let an intermediate cache (browser or
      // upstream proxy) hold a "frame" and replay it.
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Connection", "close");
      if (!frigateResp.body) {
        return res.status(502).json({ error: "Frigate returned no body" });
      }
      Readable.fromWeb(frigateResp.body as never).pipe(res);
    } catch (err) {
      next(err);
    }
  });

  // --- Camera snapshot (proxied from Frigate — auth-gated) ---
  router.get("/cameras/:name/snapshot", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const height = Math.min(Math.max(parseInt(req.query.h as string) || 480, 100), 1080);
      const frigateResp = await fetchSnapshot(req.params.name, height);
      const contentType = frigateResp.headers.get("content-type") || "image/jpeg";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=5");
      const buffer = Buffer.from(await frigateResp.arrayBuffer());
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  });

  // --- Camera events ---
  router.get("/cameras/:name/events", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const events = await getRecentEvents(limit, req.params.name);
      res.json({ events });
    } catch (err) {
      next(err);
    }
  });

  // --- Enable camera ---
  router.post("/cameras/:name/enable", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      await enableDetection(req.params.name);
      await prisma.camera.updateMany({
        where: { name: req.params.name },
        data: { enabled: true },
      });
      res.json({ status: "enabled", camera: req.params.name });
    } catch (err) {
      next(err);
    }
  });

  // --- Disable camera (Tier 2 — requires confirmation) ---
  router.post("/cameras/:name/disable", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, `camera.${req.params.name}`, "disable_camera", { name: req.params.name }, userId
      );
      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }
      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          confirmationToken: result.confirmationToken,
          reason: result.reason,
          tier: result.tier,
          expiresIn: 60,
        });
      }

      await disableDetection(req.params.name);
      await prisma.camera.updateMany({
        where: { name: req.params.name },
        data: { enabled: false },
      });
      res.json({ status: "disabled", camera: req.params.name });
    } catch (err) {
      next(err);
    }
  });

  // --- Delete camera (Tier 2 — requires confirmation) ---
  router.delete("/cameras/:name", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, `camera.${req.params.name}`, "delete_camera", { name: req.params.name }, userId
      );
      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }
      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          confirmationToken: result.confirmationToken,
          reason: result.reason,
          tier: result.tier,
          expiresIn: 60,
        });
      }

      await deleteCamera(req.params.name);
      await prisma.camera.deleteMany({ where: { name: req.params.name } });
      res.json({ status: "deleted", camera: req.params.name });
    } catch (err) {
      next(err);
    }
  });

  // --- Notification preferences ---
  router.get("/cameras/:name/notifications", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      if (!req.user) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const camera = await prisma.camera.findUnique({ where: { name: req.params.name } });
      if (!camera) return res.status(404).json({ error: "Camera not found" });

      const prefs = await prisma.cameraNotificationPref.findUnique({
        where: { userId_cameraId: { userId: req.user.id, cameraId: camera.id } },
      });

      res.json(
        prefs || { onPerson: true, onVehicle: true, onAnimal: false, onMotion: false }
      );
    } catch (err) {
      next(err);
    }
  });

  router.put("/cameras/:name/notifications", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      if (!req.user) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const camera = await prisma.camera.findUnique({ where: { name: req.params.name } });
      if (!camera) return res.status(404).json({ error: "Camera not found" });

      // Validate boolean types
      const { onPerson, onVehicle, onAnimal, onMotion } = req.body;
      const boolOrUndef = (v: unknown): boolean | undefined =>
        typeof v === "boolean" ? v : undefined;

      const prefs = await prisma.cameraNotificationPref.upsert({
        where: { userId_cameraId: { userId: req.user.id, cameraId: camera.id } },
        create: {
          userId: req.user.id,
          cameraId: camera.id,
          onPerson: boolOrUndef(onPerson) ?? true,
          onVehicle: boolOrUndef(onVehicle) ?? true,
          onAnimal: boolOrUndef(onAnimal) ?? false,
          onMotion: boolOrUndef(onMotion) ?? false,
        },
        update: {
          onPerson: boolOrUndef(onPerson),
          onVehicle: boolOrUndef(onVehicle),
          onAnimal: boolOrUndef(onAnimal),
          onMotion: boolOrUndef(onMotion),
        },
      });

      res.json(prefs);
    } catch (err) {
      next(err);
    }
  });

  // ==========================================================================
  // RECORDINGS + TIMELINE (Phase 3.1)
  // ==========================================================================
  //
  // The Recordings page hits these in sequence on load:
  //   1. summary → paint the date picker + hourly heatmap on the
  //      timeline scrubber.
  //   2. recordings → list the actual segments for the chosen window
  //      so we can compute gaps + render a contiguous progress bar.
  //   3. timeline → dot the scrubber where things happened.
  //   4. playback (mp4 range) → the <video> source for the chosen
  //      time slice. Mp4 is sufficient for windows up to ~10 minutes;
  //      Phase 3.2 will add HLS via hls.js for longer scrubs.
  //
  // All routes register under `/cameras/:name/...` because the
  // suffix discriminates them from the bare `/cameras/:name` route
  // (different segment count → no shadowing). Camera name is
  // validated; `before`/`after` are coerced to finite numbers and
  // sanity-bounded to a 31-day window so a malformed request can't
  // make Frigate scan its whole archive.

  router.get("/cameras/:name/recordings/summary", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const days = await getRecordingsSummary(req.params.name);
      res.json({ days });
    } catch (err) {
      next(err);
    }
  });

  router.get("/cameras/:name/recordings", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const range = parseRecordingRange(req);
      if ("error" in range) {
        return res.status(400).json({ error: range.error });
      }
      const segments = await getRecordings(
        req.params.name,
        range.after,
        range.before,
      );
      res.json({ segments });
    } catch (err) {
      next(err);
    }
  });

  router.get("/cameras/:name/timeline", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const range = parseRecordingRange(req);
      if ("error" in range) {
        return res.status(400).json({ error: range.error });
      }
      const entries = await getTimelineEntries(
        req.params.name,
        range.after,
        range.before,
      );
      res.json({ entries });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Range-mp4 playback. Streams Frigate's synthesised clip.mp4 for
   * the requested window. Cap at 30 minutes so a misbehaving caller
   * can't pin a Frigate worker for an hour synthesising one mp4.
   * Long-window playback comes in Phase 3.2 via HLS.
   */
  router.get("/cameras/:name/playback", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const range = parseRecordingRange(req);
      if ("error" in range) {
        return res.status(400).json({ error: range.error });
      }
      const span = range.before - range.after;
      if (span > 30 * 60) {
        return res.status(400).json({
          error: "Playback range exceeds 30 minutes — pick a smaller window or use the export endpoint",
        });
      }

      const url = buildRecordingClipUrl(req.params.name, range.after, range.before);
      const ctrl = new AbortController();
      req.on("close", () => ctrl.abort());
      // Recording mp4 synthesis can take a few seconds for longer ranges.
      // Set a generous timeout but still bounded so a stuck request
      // eventually frees the connection.
      const upstream = await fetch(url, {
        signal: AbortSignal.any
          ? AbortSignal.any([ctrl.signal, AbortSignal.timeout(60_000)])
          : ctrl.signal,
      });
      if (!upstream.ok) {
        return res.status(upstream.status).json({ error: `frigate ${upstream.status}` });
      }
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "video/mp4");
      const len = upstream.headers.get("content-length");
      if (len) res.setHeader("Content-Length", len);
      res.setHeader("Cache-Control", "private, max-age=300");
      if (upstream.body) {
        Readable.fromWeb(upstream.body as never).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      next(err);
    }
  });

  // --- HLS playback (Phase 3.2) ---
  //
  // Returns the media playlist for a VOD time range, with segment refs
  // rewritten to point at our segment proxy so .ts files stay LAN-side.
  // Lifts the 30-minute cap of the mp4 playback route — operators can
  // scrub a full hour (or more) without a synthesised stitch.
  //
  // The route resolves Frigate's master playlist, follows it to the
  // first media playlist, then rewrites that playlist's segment refs.
  // A master that's already a media playlist (no #EXT-X-STREAM-INF
  // entries, just segments) is detected and rewritten in place.
  router.get("/cameras/:name/playback.m3u8", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const range = parseRecordingRange(req);
      if ("error" in range) {
        return res.status(400).json({ error: range.error });
      }

      const masterUrl = buildVodMasterUrl(
        req.params.name,
        range.after,
        range.before,
      );
      let playlistText = await fetchHlsPlaylist(masterUrl);

      // If the master references a sub-playlist (most common Frigate
      // shape), follow the first non-comment .m3u8 reference. Otherwise
      // we treat the response as already-a-media-playlist.
      const lines = playlistText.split(/\r?\n/);
      const subRel = lines.find(
        (line) =>
          !line.startsWith("#") &&
          line.trim() !== "" &&
          line.trim().endsWith(".m3u8"),
      );
      if (subRel) {
        const subUrl = new URL(subRel.trim(), masterUrl).href;
        playlistText = await fetchHlsPlaylist(subUrl);
      }

      // Rewrite each segment line to point at our proxy. We pass the
      // range params back through so the segment route knows which VOD
      // window to fetch from. URL-encoding handles segment names with
      // weird characters even though Frigate's emit boring "0.ts".
      const segPrefix = `/api/cameras/${encodeURIComponent(req.params.name)}/playback.segment?after=${range.after}&before=${range.before}&seg=`;
      const rewritten = playlistText
        .split(/\r?\n/)
        .map((line) => {
          if (line.startsWith("#") || line.trim() === "") return line;
          // It's a URL line. Leave absolute URLs alone (defense — Frigate
          // doesn't usually emit them, but a future version might). Otherwise
          // route through our segment proxy.
          if (/^https?:\/\//i.test(line)) return line;
          return `${segPrefix}${encodeURIComponent(line.trim())}`;
        })
        .join("\n");

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-store");
      res.send(rewritten);
    } catch (err) {
      // hls.js retries on transient errors, but a clean 502 is the
      // signal that the upstream is broken (vs 4xx for "you sent us a
      // bad range").
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("HLS playlist")) {
        return res.status(502).json({ error: msg });
      }
      next(err);
    }
  });

  /** Single-segment proxy. Validates `seg` looks like a Frigate segment
   *  name (alphanumeric + .ts/.m4s) so a malicious caller can't slip a
   *  traversal path through. */
  router.get("/cameras/:name/playback.segment", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const range = parseRecordingRange(req);
      if ("error" in range) {
        return res.status(400).json({ error: range.error });
      }
      const seg = String(req.query.seg ?? "");
      // Allow only the segment shapes Frigate emits — alphanumeric +
      // single-segment filename + an extension we expect.
      if (!/^[a-zA-Z0-9_-]{1,64}\.(ts|m4s|mp4)$/.test(seg)) {
        return res.status(400).json({ error: "Invalid segment name" });
      }

      const url = buildVodSegmentUrl(
        req.params.name,
        range.after,
        range.before,
        seg,
      );
      const ctrl = new AbortController();
      req.on("close", () => ctrl.abort());
      const upstream = await fetch(url, {
        signal: AbortSignal.any
          ? AbortSignal.any([ctrl.signal, AbortSignal.timeout(30_000)])
          : ctrl.signal,
      });
      if (!upstream.ok) {
        return res.status(upstream.status).end();
      }
      res.setHeader(
        "Content-Type",
        upstream.headers.get("content-type") || "video/MP2T",
      );
      const len = upstream.headers.get("content-length");
      if (len) res.setHeader("Content-Length", len);
      // Each segment is immutable for a given (camera, range, seg)
      // tuple — long cache keeps repeat scrubs cheap.
      res.setHeader("Cache-Control", "private, max-age=3600");
      if (upstream.body) {
        Readable.fromWeb(upstream.body as never).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      next(err);
    }
  });

  // ==========================================================================
  // PER-CAMERA SETTINGS (Phase 4.1)
  // ==========================================================================
  //
  // GET returns a typed slice of Frigate's per-camera config that the
  // dashboard's settings page edits. PATCH accepts a partial update,
  // merges it into Frigate's full config, and POSTs back via
  // /api/config/save?save_option=restart so the change takes effect.
  //
  // The PATCH body is validated structurally here (types) and
  // semantically in the service (ranges). 4xx is preferred over 500
  // for bad input, so we surface the service's `Error.message` when
  // it shape-mismatches obvious things like "threshold > 1".

  router.get("/cameras/:name/settings", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const settings = await getCameraSettings(req.params.name);
      res.json({ settings });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) return void res.status(404).json({ error: msg });
      next(err);
    }
  });

  router.patch("/cameras/:name/settings", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: CameraSettingsPatch = {};

      // Per-field structural validation. The service does range +
      // semantic checks; we just keep obviously-wrong shapes out of
      // the YAML write path.
      const isBool = (v: unknown): v is boolean => typeof v === "boolean";
      const isFiniteNum = (v: unknown): v is number =>
        typeof v === "number" && Number.isFinite(v);

      if ("detectEnabled" in body) {
        if (!isBool(body.detectEnabled)) {
          return res.status(400).json({ error: "detectEnabled must be boolean" });
        }
        patch.detectEnabled = body.detectEnabled;
      }
      if ("detectFps" in body) {
        if (!isFiniteNum(body.detectFps)) {
          return res.status(400).json({ error: "detectFps must be a number" });
        }
        patch.detectFps = body.detectFps;
      }
      if ("trackedLabels" in body) {
        if (
          !Array.isArray(body.trackedLabels) ||
          body.trackedLabels.some(
            (s) => typeof s !== "string" || !/^[a-z0-9_-]{1,32}$/i.test(s),
          )
        ) {
          return res.status(400).json({
            error: "trackedLabels must be a list of label strings",
          });
        }
        patch.trackedLabels = body.trackedLabels as string[];
      }
      if ("objectFilters" in body) {
        if (
          !body.objectFilters ||
          typeof body.objectFilters !== "object" ||
          Array.isArray(body.objectFilters)
        ) {
          return res.status(400).json({
            error: "objectFilters must be an object",
          });
        }
        const filters: Record<string, { threshold?: number; minScore?: number }> = {};
        for (const [label, raw] of Object.entries(
          body.objectFilters as Record<string, unknown>,
        )) {
          if (!/^[a-z0-9_-]{1,32}$/i.test(label)) {
            return res
              .status(400)
              .json({ error: `Invalid label in objectFilters: ${label}` });
          }
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            return res
              .status(400)
              .json({ error: `objectFilters.${label} must be an object` });
          }
          const r = raw as Record<string, unknown>;
          const entry: { threshold?: number; minScore?: number } = {};
          if ("threshold" in r) {
            if (!isFiniteNum(r.threshold)) {
              return res.status(400).json({
                error: `objectFilters.${label}.threshold must be a number`,
              });
            }
            entry.threshold = r.threshold;
          }
          if ("minScore" in r) {
            if (!isFiniteNum(r.minScore)) {
              return res.status(400).json({
                error: `objectFilters.${label}.minScore must be a number`,
              });
            }
            entry.minScore = r.minScore;
          }
          filters[label] = entry;
        }
        patch.objectFilters = filters;
      }
      if ("recordEnabled" in body) {
        if (!isBool(body.recordEnabled)) {
          return res.status(400).json({ error: "recordEnabled must be boolean" });
        }
        patch.recordEnabled = body.recordEnabled;
      }
      if ("recordRetainDays" in body) {
        if (!isFiniteNum(body.recordRetainDays)) {
          return res
            .status(400)
            .json({ error: "recordRetainDays must be a number" });
        }
        patch.recordRetainDays = body.recordRetainDays;
      }
      if ("snapshotsEnabled" in body) {
        if (!isBool(body.snapshotsEnabled)) {
          return res
            .status(400)
            .json({ error: "snapshotsEnabled must be boolean" });
        }
        patch.snapshotsEnabled = body.snapshotsEnabled;
      }
      if ("snapshotRetainDays" in body) {
        if (!isFiniteNum(body.snapshotRetainDays)) {
          return res
            .status(400)
            .json({ error: "snapshotRetainDays must be a number" });
        }
        patch.snapshotRetainDays = body.snapshotRetainDays;
      }
      if ("zones" in body) {
        if (!Array.isArray(body.zones)) {
          return res.status(400).json({ error: "zones must be an array" });
        }
        const zones: typeof patch.zones = [];
        for (const raw of body.zones) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            return res.status(400).json({ error: "Each zone must be an object" });
          }
          const z = raw as Record<string, unknown>;
          if (typeof z.name !== "string") {
            return res.status(400).json({ error: "Zone name must be a string" });
          }
          if (
            !Array.isArray(z.coordinates) ||
            z.coordinates.some((c) => typeof c !== "number")
          ) {
            return res
              .status(400)
              .json({ error: `Zone ${z.name} coordinates must be a number array` });
          }
          if (z.objects !== undefined && !Array.isArray(z.objects)) {
            return res
              .status(400)
              .json({ error: `Zone ${z.name} objects must be an array` });
          }
          zones.push({
            name: z.name,
            coordinates: z.coordinates as number[],
            objects: Array.isArray(z.objects) ? (z.objects as string[]) : [],
            inertia: typeof z.inertia === "number" ? z.inertia : 3,
          });
        }
        patch.zones = zones;
      }
      if ("motionMasks" in body) {
        if (!Array.isArray(body.motionMasks)) {
          return res.status(400).json({ error: "motionMasks must be an array" });
        }
        const masks: typeof patch.motionMasks = [];
        for (const raw of body.motionMasks) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            return res
              .status(400)
              .json({ error: "Each motion mask must be an object" });
          }
          const m = raw as Record<string, unknown>;
          if (
            !Array.isArray(m.coordinates) ||
            m.coordinates.some((c) => typeof c !== "number")
          ) {
            return res.status(400).json({
              error: "Motion mask coordinates must be a number array",
            });
          }
          masks.push({ coordinates: m.coordinates as number[] });
        }
        patch.motionMasks = masks;
      }

      const settings = await updateCameraSettings(req.params.name, patch);
      res.json({ settings });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) return void res.status(404).json({ error: msg });
      // Surface range/threshold errors as 400 so the dashboard can
      // render them inline next to the offending control.
      if (
        msg.includes("must be between") ||
        msg.includes("Frigate rejected")
      ) {
        return void res.status(400).json({ error: msg });
      }
      next(err);
    }
  });

  // ==========================================================================
  // CLIP EXPORT + SHARE URLS (PR #3)
  // ==========================================================================
  //
  // POST /cameras/:name/clips/export and GET /cameras/:name/live-url stay
  // here because the extra path segments after :name disambiguate them from
  // the bare /cameras/:name handler. The bare-prefix routes
  // (/cameras/clips, /cameras/clips/event/:eventId, /cameras/clips/share)
  // are defined at the TOP of this function above /cameras/:name to avoid
  // the route-shadowing trap documented in the file header.

  /**
   * POST /cameras/:name/clips/export
   *   Export a time-range clip and stash it in /Clips/<camera>/<ts>.mp4 in
   *   the user's Nextcloud. Returns the resulting Nextcloud path so the
   *   dashboard can deep-link into the Files app.
   */
  router.post("/cameras/:name/clips/export", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const schema = z.object({
        starts_at: z.string().datetime(),
        ends_at: z.string().datetime(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      }
      const ncToken = await resolveNcToken(req);
      if (!ncToken) return res.status(401).json({ error: "nextcloud_session_missing" });
      const userId = req.user?.username;
      if (!userId) return res.status(401).json({ error: "unauthenticated" });

      const result = await exportClip(ncToken, userId, {
        camera: req.params.name,
        startsAt: new Date(parsed.data.starts_at),
        endsAt: new Date(parsed.data.ends_at),
      });
      res.status(201).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "invalid_camera_name") return void res.status(400).json({ error: msg });
      if (msg.includes("must be after")) return void res.status(400).json({ error: msg });
      if (msg.includes("duration capped")) return void res.status(400).json({ error: msg });
      if (msg.includes("clip too large")) return void res.status(413).json({ error: msg });
      if (msg.includes("frigate_export_failed")) return void res.status(502).json({ error: msg });
      next(err);
    }
  });

  // ==========================================================================
  // PTZ (Phase 6.1)
  // ==========================================================================
  //
  // GET /cameras/:name/ptz returns capabilities + preset list (or
  // {supportsPanTilt: false, ...} when the camera isn't a PTZ).
  // POST /cameras/:name/ptz body { action } moves the camera. Each
  // action runs Frigate's continuous-motion API — the dashboard sends
  // a STOP after the operator releases the button, otherwise the
  // camera will keep moving.
  // POST /cameras/:name/ptz/preset body { preset } recalls a saved
  // preset by name.

  router.get("/cameras/:name/ptz", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const caps = await fetchPtzCapabilities(req.params.name);
      res.json(caps);
    } catch (err) {
      next(err);
    }
  });

  router.post("/cameras/:name/ptz", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const allowed: PtzAction[] = [
        "MOVE_UP",
        "MOVE_DOWN",
        "MOVE_LEFT",
        "MOVE_RIGHT",
        "ZOOM_IN",
        "ZOOM_OUT",
        "STOP",
      ];
      const action = String((req.body ?? {}).action ?? "");
      if (!allowed.includes(action as PtzAction)) {
        return res.status(400).json({
          error: `action must be one of: ${allowed.join(", ")}`,
        });
      }
      await ptzMove(req.params.name, action as PtzAction);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.post("/cameras/:name/ptz/preset", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const preset = String((req.body ?? {}).preset ?? "").trim();
      // Frigate preset names are alphanumeric-with-spaces in practice.
      // Tighten to the same character class we use for camera names so
      // a malicious caller can't slip path-traversal through.
      if (!/^[a-zA-Z0-9 _-]{1,64}$/.test(preset)) {
        return res.status(400).json({ error: "Invalid preset name" });
      }
      await ptzGoToPreset(req.params.name, preset);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /cameras/:name/live-url
   *   Returns the dashboard URL the user can open to see a live view.
   *   Intentionally NOT a signed URL — the dashboard handles the playback
   *   via the existing snapshot polling endpoint, which is already
   *   session-authenticated.
   */
  router.get("/cameras/:name/live-url", (req, res) => {
    if (!isValidCameraName(req.params.name)) {
      return res.status(400).json({ error: "Invalid camera name" });
    }
    res.json({
      live_url: `/cameras/${encodeURIComponent(req.params.name)}`,
      snapshot_url: `/api/cameras/${encodeURIComponent(req.params.name)}/snapshot`,
    });
  });

  return router;
}

/**
 * Parse + sanity-check a recording range from query params (`after`,
 * `before` in Unix seconds). Returns `{ after, before }` on success or
 * `{ error }` for the caller to surface as 400.
 *
 * Both bounds must be positive finite numbers, after must be earlier
 * than before, and the total span is capped at 31 days so a careless
 * `?before=0&after=2000000000` doesn't make Frigate scan its whole
 * archive (and our timeline endpoint return 1000s of rows).
 */
function parseRecordingRange(req: import("express").Request):
  | { after: number; before: number }
  | { error: string } {
  const q = req.query as Record<string, string | undefined>;
  const a = Number(q.after);
  const b = Number(q.before);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return { error: "after and before must be Unix-second timestamps" };
  }
  if (a <= 0 || b <= 0) {
    return { error: "after and before must be positive" };
  }
  if (a >= b) {
    return { error: "after must be earlier than before" };
  }
  if (b - a > 31 * 24 * 60 * 60) {
    return { error: "range exceeds 31 days" };
  }
  return { after: a, before: b };
}

/** Defense-in-depth path validation mirroring PR #1's validateNcPath
 *  logic. Reject traversal markers (raw and percent-decoded) so a caller
 *  can't sign a share URL whose ncPath escapes their Nextcloud namespace. */
function isSafeNcPath(input: string): { ok: true; path: string } | { ok: false; error: string } {
  if (input.length > 4096) return { ok: false, error: "nc_path too long" };
  if (input.includes("\0")) return { ok: false, error: "null byte in nc_path" };
  let decoded = input;
  for (let i = 0; i < 4 && decoded.includes("%"); i++) {
    let next: string;
    try { next = decodeURIComponent(decoded); } catch { return { ok: false, error: "malformed percent-encoding in nc_path" }; }
    if (next === decoded) break;
    decoded = next;
  }
  for (const candidate of [input, decoded]) {
    if (candidate.split(/[\\/]/).some((seg) => seg === "..")) {
      return { ok: false, error: "nc_path traversal not allowed" };
    }
  }
  const normalized = decoded.startsWith("/") ? decoded : "/" + decoded;
  return { ok: true, path: normalized };
}

/**
 * Public router for the share endpoint — no auth, signed token in query is
 * the authorization. Mounted in app.ts BEFORE the auth middleware so a
 * forwarded link works without a Droplet session. The Nextcloud token used
 * to actually fetch the file isn't the recipient's — it's an admin-scoped
 * fetch, so the recipient never gets implicit access to anything else.
 */
export function createCameraSharePublicRouter(): Router {
  const router = Router();
  router.get("/cameras/clips/share/:filename", async (req, res, next) => {
    try {
      const token = req.query.t as string | undefined;
      if (!token) return res.status(403).json({ error: "missing_token" });
      const verified = verifyShareUrl(token);
      if (!verified) return res.status(403).json({ error: "invalid_or_expired_token" });

      // Resolve the file via the SAME user's Nextcloud namespace. We don't
      // have their cookie here — a long-lived service-account NC token
      // would be required for true zero-recipient-context fetch, which is
      // a deployment concern. For v1 we return a clear error if the
      // service account isn't configured; the share URL still won't leak
      // because the token verification already passed.
      const ncToken = process.env.NEXTCLOUD_SERVICE_TOKEN;
      if (!ncToken) {
        return res.status(503).json({
          error: "share_service_not_configured",
          hint: "Set NEXTCLOUD_SERVICE_TOKEN to enable cross-session clip sharing.",
        });
      }

      const stream = await ncDownloadFile(ncToken, verified.userId, verified.ncPath);
      if (!stream) return res.status(404).json({ error: "clip_not_found" });

      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", `inline; filename="${req.params.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`);
      const { Readable } = await import("node:stream");
      Readable.fromWeb(stream as never).pipe(res);
    } catch (err) {
      next(err);
    }
  });
  return router;
}
