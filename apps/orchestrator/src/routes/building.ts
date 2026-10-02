/**
 * `/api/building/*` — commercial and industrial device control (BACnet/IP,
 * Modbus TCP, SNMP, KNX/IP) through services/device-gateway.
 *
 * Part of the Device control module (`smart_home`, beside Matter), so the
 * module toggle gates these routes with the rest of the surface.
 *
 * Who may do what:
 *   - read devices / values: owner, admin, staff (`family`) and the MCP
 *     principal (the `get_building_devices` tool);
 *   - change the registry, discover, list templates: owner/admin, dashboard only;
 *   - write a point: owner/admin and the MCP principal (`set_building_point`).
 *
 * A write is confirmed BEFORE it reaches this route — by the dashboard's
 * confirm dialog, or by the tools-core interceptor for the chat / MCP tool
 * (`requiresConfirmation`) — so this route mints no token of its own (that
 * would be the WARP-2472 double prompt). What it adds is the audit, and the
 * audit fails CLOSED: the CommandAuditLog row is written first, and if it
 * cannot be, nothing is sent. The gateway then re-guards the write itself
 * (registry `writable` + bounds, and plan-only unless DEVICE_GATEWAY_LIVE_WRITES).
 */

import { Router, type NextFunction, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireRole, requireRoleOrMcpService } from "../middleware/auth.js";
import * as gateway from "../services/device-gateway.client.js";
import { DeviceGatewayError, type DeviceProtocol } from "../services/device-gateway.client.js";
import { recordActivity } from "../services/activity.singleton.js";
import type { ActivityActor } from "../services/activity.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("building-routes");

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROTOCOLS: readonly DeviceProtocol[] = ["bacnet", "modbus", "snmp", "knx"];
/** Audit-row tier: every building write is a confirmed (Tier-2-class) change. */
const WRITE_TIER = 2;

const READERS = requireRoleOrMcpService("owner", "admin", "family");
const WRITERS = requireRoleOrMcpService("owner", "admin");
const ADMINS = requireRole("owner", "admin");

/** Gateway errors keep their status and message; anything else is the error handler's. */
function sendGatewayError(res: Response, err: unknown, next: NextFunction): void {
  if (err instanceof DeviceGatewayError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  next(err);
}

function slugParam(res: Response, value: string, what: string): boolean {
  if (SLUG.test(value)) return true;
  res.status(400).json({ error: `Invalid ${what}` });
  return false;
}

/** Same attribution rule as network-safety: a service principal is the AI acting. */
function actorOf(user: { id?: string; role?: string } | undefined): ActivityActor {
  if (!user?.id) return { type: "anonymous" };
  if (user.role === "service" || user.id.startsWith("_service:")) return { type: "ai", id: null };
  return { type: "user", id: user.id };
}

export function createBuildingRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/building/health", READERS, async (_req, res, next) => {
    try {
      res.json(await gateway.health());
    } catch (err) {
      sendGatewayError(res, err, next);
    }
  });

  router.get("/building/devices", READERS, async (_req, res, next) => {
    try {
      res.json({ devices: await gateway.listDevices() });
    } catch (err) {
      sendGatewayError(res, err, next);
    }
  });

  router.get("/building/templates", ADMINS, async (_req, res, next) => {
    try {
      res.json(await gateway.templates());
    } catch (err) {
      sendGatewayError(res, err, next);
    }
  });

  router.get("/building/devices/:id", READERS, async (req, res, next) => {
    if (!slugParam(res, req.params.id, "device id")) return;
    try {
      res.json(await gateway.getDevice(req.params.id));
    } catch (err) {
      sendGatewayError(res, err, next);
    }
  });

  router.get("/building/devices/:id/values", READERS, async (req, res, next) => {
    if (!slugParam(res, req.params.id, "device id")) return;
    try {
      res.json(await gateway.readValues(req.params.id));
    } catch (err) {
      sendGatewayError(res, err, next);
    }
  });

  router.put("/building/devices/:id", ADMINS, async (req, res, next) => {
    if (!slugParam(res, req.params.id, "device id")) return;
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.status(400).json({ error: "Body must be a device object" });
    }
    try {
      const saved = await gateway.putDevice(req.params.id, req.body);
      void recordActivity({
        kind: "smart_home",
        severity: "info",
        sourceIcon: "building",
        actor: actorOf(req.user),
        what: `Device saved: ${saved.name}`,
        sub: `${saved.protocol} • ${saved.address}`,
        refs: { deviceId: saved.id, protocol: saved.protocol, points: saved.points.length },
      });
      res.json(saved);
    } catch (err) {
      sendGatewayError(res, err, next);
    }
  });

  router.delete("/building/devices/:id", ADMINS, async (req, res, next) => {
    if (!slugParam(res, req.params.id, "device id")) return;
    try {
      await gateway.deleteDevice(req.params.id);
      void recordActivity({
        kind: "smart_home",
        severity: "info",
        sourceIcon: "building",
        actor: actorOf(req.user),
        what: `Device removed: ${req.params.id}`,
        refs: { deviceId: req.params.id },
      });
      res.status(204).end();
    } catch (err) {
      sendGatewayError(res, err, next);
    }
  });

  router.post("/building/discover", ADMINS, async (req, res, next) => {
    const protocol = req.body?.protocol as DeviceProtocol;
    if (!PROTOCOLS.includes(protocol)) {
      return res.status(400).json({ error: `protocol must be one of: ${PROTOCOLS.join(", ")}` });
    }
    try {
      res.json(await gateway.discover(protocol));
    } catch (err) {
      sendGatewayError(res, err, next);
    }
  });

  router.post("/building/devices/:id/points/:pointId/write", WRITERS, async (req, res, next) => {
    const { id, pointId } = req.params;
    if (!slugParam(res, id, "device id") || !slugParam(res, pointId, "point id")) return;
    const value: unknown = req.body?.value;
    if (typeof value !== "boolean" && typeof value !== "number" && typeof value !== "string") {
      return res.status(400).json({ error: "'value' must be a number, true/false, or text" });
    }
    const userId = req.user?.id ?? null;
    const entityId = `building.${id}.${pointId}`;

    // Fail-closed audit: no row, no write.
    try {
      await prisma.commandAuditLog.create({
        data: {
          userId,
          entityId,
          domain: "building",
          service: "write_point",
          data: { value },
          tier: WRITE_TIER,
          confirmed: true,
          blocked: false,
        },
      });
    } catch (err) {
      logger.error({ err, entityId }, "building write audit failed — write not sent");
      return res.status(503).json({
        error: "The change was not sent: its audit record could not be written.",
        code: "audit_unavailable",
      });
    }

    try {
      const result = await gateway.writePoint(id, pointId, value);
      void recordActivity({
        kind: "smart_home",
        severity: result.applied ? "ok" : "info",
        sourceIcon: "building",
        actor: actorOf(req.user),
        what: result.applied
          ? `Set ${id} ${pointId} to ${String(value)}`
          : `Planned ${id} ${pointId} = ${String(value)} (live writes off)`,
        sub: `${result.plan.protocol} • tier ${WRITE_TIER}`,
        refs: {
          entityId,
          applied: result.applied,
          liveWrites: result.live_writes,
          readback: result.readback ?? null,
          principal: userId,
        },
      });
      res.json(result);
    } catch (err) {
      void recordActivity({
        kind: "smart_home",
        severity: "warn",
        sourceIcon: "building",
        actor: actorOf(req.user),
        what: `Could not set ${id} ${pointId}`,
        sub: err instanceof Error ? err.message : String(err),
        refs: { entityId, principal: userId },
      });
      sendGatewayError(res, err, next);
    }
  });

  return router;
}
