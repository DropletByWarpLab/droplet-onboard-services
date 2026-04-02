/**
 * Smart Home API routes — device listing, control, discovery, and SSE events.
 */

import { Router } from "express";
import pino from "pino";
import {
  getGroupedDevices,
  getDevice,
  sendCommand,
  getDiscovered,
  acceptDiscovered,
  subscribeStateChanges,
  isInitialized,
} from "../services/smart-home.service.js";

const logger = pino({ name: "smart-home-routes" });

export function createSmartHomeRouter(): Router {
  const router = Router();

  // --- List grouped devices ---
  router.get("/devices/smart-home", async (_req, res, next) => {
    try {
      if (!isInitialized()) {
        return res.json({
          lights: [],
          switches: [],
          sensors: [],
          climate: [],
          media: [],
          covers: [],
          other: [],
          _status: "disconnected",
        });
      }
      const grouped = await getGroupedDevices();
      res.json(grouped);
    } catch (err) {
      next(err);
    }
  });

  // --- SSE stream of state changes ---
  router.get("/devices/smart-home/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Send initial connected event
    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

    // Heartbeat every 30s to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 30_000);

    // Subscribe to state changes
    const unsubscribe = subscribeStateChanges((event) => {
      try {
        res.write(`data: ${JSON.stringify({ type: "state_changed", ...event })}\n\n`);
      } catch {
        // Client may have disconnected
      }
    });

    // Cleanup on client disconnect
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // --- Discovered devices ---
  router.get("/devices/smart-home/discovered", async (_req, res, next) => {
    try {
      if (!isInitialized()) return res.json([]);
      const discovered = await getDiscovered();
      res.json(discovered);
    } catch (err) {
      next(err);
    }
  });

  // --- Single device ---
  router.get("/devices/smart-home/:entityId", async (req, res, next) => {
    try {
      if (!isInitialized()) {
        return res.status(503).json({ error: "Home Assistant not connected" });
      }
      const device = await getDevice(req.params.entityId);
      if (!device) return res.status(404).json({ error: "Entity not found" });
      res.json(device);
    } catch (err) {
      next(err);
    }
  });

  // --- Send command ---
  router.post("/devices/smart-home/:entityId/command", async (req, res, next) => {
    try {
      if (!isInitialized()) {
        return res.status(503).json({ error: "Home Assistant not connected" });
      }

      const { service, data } = req.body;
      if (!service || typeof service !== "string") {
        return res.status(400).json({ error: "Missing 'service' in request body" });
      }

      await sendCommand(req.params.entityId, service, data);
      res.json({ status: "ok", entityId: req.params.entityId, service });
    } catch (err) {
      next(err);
    }
  });

  // --- Accept discovered device ---
  router.post(
    "/devices/smart-home/discovered/:flowId/accept",
    async (req, res, next) => {
      try {
        if (!isInitialized()) {
          return res.status(503).json({ error: "Home Assistant not connected" });
        }
        await acceptDiscovered(req.params.flowId);
        res.json({ status: "accepted", flowId: req.params.flowId });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
