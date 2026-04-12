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
  enableDetection,
  disableDetection,
  deleteCamera,
} from "../services/frigate.client.js";
import { config } from "../config.js";
import { evaluateNetworkCommand } from "../services/network-safety.service.js";

const logger = pino({ name: "cameras-routes" });

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
        headers: { "Content-Type": "application/json" },
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

  return router;
}
