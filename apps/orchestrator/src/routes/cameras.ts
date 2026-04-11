/**
 * Camera API routes — listing, snapshots, events, discovery, and SSE notifications.
 *
 * All camera streams and snapshots are proxied through these authenticated
 * endpoints so camera IPs are never exposed to external clients. Works
 * identically on-LAN and off-LAN via the Nginx HTTPS gateway.
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

const logger = pino({ name: "cameras-routes" });

export function createCamerasRouter(prisma: PrismaClient): Router {
  const router = Router();

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

    // Send initial connected event
    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

    // Heartbeat every 30s
    const heartbeat = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 30_000);

    // Subscribe to camera events
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

  // --- Single camera details ---
  router.get("/cameras/:name", async (req, res, next) => {
    try {
      const cameras = await getCameras(prisma);
      const camera = cameras.find((c) => c.name === req.params.name);
      if (!camera) {
        return res.status(404).json({ error: "Camera not found" });
      }

      // Fetch recent events for this camera
      const events = await getRecentEvents(5, req.params.name);
      res.json({ ...camera, recentEvents: events });
    } catch (err) {
      next(err);
    }
  });

  // --- Camera snapshot (proxied from Frigate — auth-gated) ---
  router.get("/cameras/:name/snapshot", async (req, res, next) => {
    try {
      const height = parseInt(req.query.h as string) || 480;
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

  // --- Disable camera ---
  router.post("/cameras/:name/disable", async (req, res, next) => {
    try {
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

  // --- Delete camera ---
  router.delete("/cameras/:name", async (req, res, next) => {
    try {
      await deleteCamera(req.params.name);
      await prisma.camera.deleteMany({ where: { name: req.params.name } });
      res.json({ status: "deleted", camera: req.params.name });
    } catch (err) {
      next(err);
    }
  });

  // --- Driver status (proxied from camera-discovery service) ---
  router.get("/cameras/drivers", async (_req, res, next) => {
    try {
      // Camera-discovery runs on host network, same as routing service
      const discoveryUrl = process.env.CAMERA_DISCOVERY_URL || "http://localhost:8085";
      const resp = await fetch(`${discoveryUrl}/drivers`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        return res.status(resp.status).json({ error: "Driver check failed" });
      }
      const data = await resp.json();
      res.json(data);
    } catch {
      // Service may not be running
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
      const discoveryUrl = process.env.CAMERA_DISCOVERY_URL || "http://localhost:8085";
      const resp = await fetch(`${discoveryUrl}/drivers/fix`, {
        method: "POST",
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

  // --- Notification preferences ---
  router.get("/cameras/:name/notifications", async (req, res, next) => {
    try {
      const userId = req.user?.id || "dev";
      const camera = await prisma.camera.findUnique({ where: { name: req.params.name } });
      if (!camera) return res.status(404).json({ error: "Camera not found" });

      const prefs = await prisma.cameraNotificationPref.findUnique({
        where: { userId_cameraId: { userId, cameraId: camera.id } },
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
      const userId = req.user?.id || "dev";
      const camera = await prisma.camera.findUnique({ where: { name: req.params.name } });
      if (!camera) return res.status(404).json({ error: "Camera not found" });

      const { onPerson, onVehicle, onAnimal, onMotion } = req.body;
      const prefs = await prisma.cameraNotificationPref.upsert({
        where: { userId_cameraId: { userId, cameraId: camera.id } },
        create: {
          userId,
          cameraId: camera.id,
          onPerson: onPerson ?? true,
          onVehicle: onVehicle ?? true,
          onAnimal: onAnimal ?? false,
          onMotion: onMotion ?? false,
        },
        update: {
          onPerson: onPerson ?? undefined,
          onVehicle: onVehicle ?? undefined,
          onAnimal: onAnimal ?? undefined,
          onMotion: onMotion ?? undefined,
        },
      });

      res.json(prefs);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
