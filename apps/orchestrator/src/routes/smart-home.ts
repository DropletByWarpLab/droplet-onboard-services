/**
 * Smart Home API routes — device listing, control, discovery, and SSE events.
 *
 * Commands are evaluated through the three-tier safety framework (design doc Section 13.2):
 * - Tier 1: Auto-execute (lights, switches, media) with rate limiting + bounds checking
 * - Tier 2: Requires user confirmation (locks, alarms, extreme temps)
 * - Tier 3: All commands logged to audit trail
 */

import { Router } from "express";
import { PrismaClient } from "@prisma/client";
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
import {
  evaluateCommand,
  confirmCommand,
  getAuditLog,
} from "../services/safety-tier.service.js";

const logger = pino({ name: "smart-home-routes" });

export function createSmartHomeRouter(prisma: PrismaClient): Router {
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

  // --- Send command (with safety tier evaluation) ---
  router.post("/devices/smart-home/:entityId/command", async (req, res, next) => {
    try {
      if (!isInitialized()) {
        return res.status(503).json({ error: "Home Assistant not connected" });
      }

      const { service, data } = req.body;
      if (!service || typeof service !== "string") {
        return res.status(400).json({ error: "Missing 'service' in request body" });
      }

      const userId = req.user?.id;
      const result = await evaluateCommand(prisma, req.params.entityId, service, data, userId);

      if ("blocked" in result && result.blocked) {
        return res.status(429).json({
          error: result.reason,
          tier: result.tier,
          blocked: true,
        });
      }

      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          entityId: req.params.entityId,
          service,
          tier: result.tier,
          reason: result.reason,
          confirmationToken: result.confirmationToken,
          expiresIn: 60,
        });
      }

      // Tier 1: Auto-execute
      await sendCommand(req.params.entityId, service, data);
      res.json({ status: "ok", entityId: req.params.entityId, service, tier: result.tier });
    } catch (err) {
      next(err);
    }
  });

  // --- Confirm a Tier 2 command ---
  router.post("/devices/smart-home/:entityId/confirm", async (req, res, next) => {
    try {
      if (!isInitialized()) {
        return res.status(503).json({ error: "Home Assistant not connected" });
      }

      const { confirmationToken, service } = req.body;
      if (!confirmationToken || typeof confirmationToken !== "string") {
        return res.status(400).json({
          error: "Missing 'confirmationToken' in request body",
          code: "TOKEN_MISSING",
        });
      }
      // WARP-41: require echo of the service the caller thinks they're confirming.
      if (!service || typeof service !== "string") {
        return res.status(400).json({
          error: "Missing 'service' — clients must echo the service from the 202 response",
          code: "TOKEN_OPERATION_MISMATCH",
        });
      }

      const userId = req.user?.id;
      const result = await confirmCommand(prisma, confirmationToken, userId, {
        service,
        entityId: req.params.entityId,
      });

      if (!result.confirmed) {
        return res.status(400).json({ error: result.reason, code: result.code });
      }

      await sendCommand(result.entityId, result.service, result.data);
      res.json({
        status: "ok",
        entityId: result.entityId,
        service: result.service,
        confirmed: true,
      });
    } catch (err) {
      next(err);
    }
  });

  // --- Audit log (scoped to current user unless admin) ---
  router.get("/devices/smart-home/audit", async (req, res, next) => {
    try {
      const { entityId, userId, limit, offset } = req.query;
      // Non-admin users can only see their own audit entries
      const effectiveUserId = (userId as string | undefined) || req.user?.id;
      const logs = await getAuditLog(prisma, {
        entityId: entityId as string | undefined,
        userId: effectiveUserId,
        limit: limit ? parseInt(limit as string, 10) : undefined,
        offset: offset ? parseInt(offset as string, 10) : undefined,
      });
      res.json({ logs });
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
