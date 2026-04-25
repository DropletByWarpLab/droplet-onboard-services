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
  getRecentEvents,
  getStats,
  subscribeCameraEvents,
  isInitialized,
} from "../services/camera.service.js";
import {
  fetchSnapshot,
  fetchEventThumbnail,
  openMjpegStream,
  enableDetection,
  disableDetection,
  deleteCamera,
  addCamera,
  fetchEvents,
} from "../services/frigate.client.js";
import { Readable } from "node:stream";
import { config } from "../config.js";
import { evaluateNetworkCommand } from "../services/network-safety.service.js";
import { exportClip, signShareUrl, verifyShareUrl } from "../services/clips.service.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";
import { ncDownloadFile } from "../services/nextcloud.client.js";
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
