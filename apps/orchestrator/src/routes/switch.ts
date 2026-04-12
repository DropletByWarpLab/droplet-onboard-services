/**
 * Managed switch API routes — port status, VLANs, PoE, WAN detection.
 *
 * ALL mutation endpoints go through the safety tier system:
 * - Tier 1: Read-only operations (get ports, get VLANs, get PoE)
 * - Tier 2: All writes require user confirmation (port enable/disable,
 *           VLAN create/delete/membership, PoE toggle, camera setup)
 * - Tier 3: Disabling the protected port (Jetson's port) is blocked for AI
 *
 * Proxies requests to the switch service (default :8081) which talks
 * to the hardware via the active driver (Lantronix for prototype,
 * custom ASIC for production).
 */

import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import pino from "pino";
import * as switchClient from "../services/switch.client.js";
import {
  evaluateNetworkCommand,
  confirmNetworkCommand,
} from "../services/network-safety.service.js";

const logger = pino({ name: "switch-routes" });

/**
 * Protected port: the port the Jetson/Droplet appliance is connected to.
 * Disabling this port or moving it to a non-management VLAN would sever
 * all connectivity. This is configurable via SWITCH_PROTECTED_PORT env var.
 * Default: 0 (no protection, auto-detect if possible).
 */
const PROTECTED_PORT = parseInt(process.env.SWITCH_PROTECTED_PORT || "0");

/** Helper: evaluate a switch command through the safety tier system. */
async function evalSwitchCommand(
  prisma: PrismaClient,
  operation: string,
  params: Record<string, unknown>,
  userId?: string,
  source: "api" | "ai" = "api"
) {
  return evaluateNetworkCommand(
    prisma,
    `switch.${operation}`,
    operation,
    params,
    userId,
    source,
  );
}

/** Helper: check if a port is the protected Jetson port. */
function isProtectedPort(port: number): boolean {
  return PROTECTED_PORT > 0 && port === PROTECTED_PORT;
}

/** Helper: return safety tier response (202 for confirmation, 403/429 for blocked). */
function safetyResponse(
  res: any,
  result: { requiresConfirmation?: boolean; confirmationToken?: string; reason?: string; tier?: number; blocked?: boolean }
) {
  if ("blocked" in result && result.blocked) {
    return res.status(result.tier === 3 ? 403 : 429).json({
      error: result.reason,
      tier: result.tier,
      blocked: true,
    });
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
}

export function createSwitchRouter(prisma: PrismaClient): Router {
  const router = Router();

  // =====================================================================
  // READ-ONLY (Tier 1 — no confirmation needed)
  // =====================================================================

  router.get("/switch/ports", async (_req, res, next) => {
    try {
      const ports = await switchClient.fetchPorts();
      res.json({ ports });
    } catch (err) {
      next(err);
    }
  });

  router.get("/switch/ports/:port", async (req, res, next) => {
    try {
      const port = parseInt(req.params.port);
      if (isNaN(port) || port < 1 || port > 10) {
        return res.status(400).json({ error: "Invalid port number (1-10)" });
      }
      const data = await switchClient.fetchPort(port);
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  router.get("/switch/vlans", async (_req, res, next) => {
    try {
      const vlans = await switchClient.fetchVlans();
      res.json({ vlans });
    } catch (err) {
      next(err);
    }
  });

  router.get("/switch/vlans/:vlanId/membership", async (req, res, next) => {
    try {
      const vlanId = parseInt(req.params.vlanId);
      const data = await switchClient.fetchVlanMembership(vlanId);
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  router.get("/switch/poe", async (_req, res, next) => {
    try {
      const ports = await switchClient.fetchPoeStatus();
      res.json({ ports });
    } catch (err) {
      next(err);
    }
  });

  router.get("/switch/poe/:port", async (req, res, next) => {
    try {
      const port = parseInt(req.params.port);
      if (isNaN(port) || port < 1 || port > 8) {
        return res.status(400).json({ error: "PoE port must be 1-8 (copper only)" });
      }
      const data = await switchClient.fetchPortPoe(port);
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  router.get("/switch/system", async (_req, res, next) => {
    try {
      const info = await switchClient.fetchSystemInfo();
      res.json(info);
    } catch (err) {
      next(err);
    }
  });

  // Confirmation endpoint (shared for all switch Tier 2 operations)
  router.post("/switch/command/confirm", async (req, res, next) => {
    try {
      const { confirmationToken } = req.body;
      if (!confirmationToken) {
        return res.status(400).json({ error: "Missing confirmationToken" });
      }
      const result = await confirmNetworkCommand(prisma, confirmationToken, req.user?.id);
      if (!result.confirmed) {
        return res.status(400).json({ error: result.reason });
      }

      // Execute the confirmed operation
      const { operation, params } = result;
      const p = (params || {}) as Record<string, unknown>;

      switch (operation) {
        case "switch_port_enable":
          await switchClient.enablePort(p.port as number);
          break;
        case "switch_port_disable":
          await switchClient.disablePort(p.port as number);
          break;
        case "switch_create_vlan":
          await switchClient.createVlan(p.vlan_id as number, (p.name as string) || "");
          break;
        case "switch_delete_vlan":
          await switchClient.deleteVlan(p.vlan_id as number);
          break;
        case "switch_set_vlan_membership":
          await switchClient.setVlanMembership(p.vlan_id as number, p.ports as any);
          break;
        case "switch_poe_enable":
          await switchClient.enablePortPoe(p.port as number);
          break;
        case "switch_poe_disable":
          await switchClient.disablePortPoe(p.port as number);
          break;
        case "switch_setup_cameras":
          await switchClient.setupCameraPorts(
            p.vlan_id as number,
            p.camera_ports as number[],
            p.uplink_ports as number[],
          );
          break;
        default:
          return res.status(400).json({ error: `Unknown operation: ${operation}` });
      }

      res.json({ status: "ok", operation, confirmed: true });
    } catch (err) {
      next(err);
    }
  });

  // =====================================================================
  // MUTATIONS (Tier 2 — require user confirmation)
  // =====================================================================

  // --- Port enable/disable ---

  router.post("/switch/ports/:port/enable", async (req, res, next) => {
    try {
      const port = parseInt(req.params.port);
      if (isNaN(port) || port < 1 || port > 10) {
        return res.status(400).json({ error: "Invalid port number" });
      }
      const result = await evalSwitchCommand(prisma, "switch_port_enable", { port }, req.user?.id);
      if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      await switchClient.enablePort(port);
      res.json({ status: "ok", port, enabled: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/switch/ports/:port/disable", async (req, res, next) => {
    try {
      const port = parseInt(req.params.port);
      if (isNaN(port) || port < 1 || port > 10) {
        return res.status(400).json({ error: "Invalid port number" });
      }
      // Protected port: block AI entirely, require confirmation for web UI
      if (isProtectedPort(port)) {
        const result = await evalSwitchCommand(
          prisma, "switch_disable_protected_port", { port }, req.user?.id
        );
        if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      } else {
        const result = await evalSwitchCommand(prisma, "switch_port_disable", { port }, req.user?.id);
        if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      }
      await switchClient.disablePort(port);
      res.json({ status: "ok", port, enabled: false });
    } catch (err) {
      next(err);
    }
  });

  // --- VLAN create/delete/membership ---

  router.post("/switch/vlans", async (req, res, next) => {
    try {
      const { vlan_id, name } = req.body;
      if (!vlan_id || vlan_id < 2 || vlan_id > 4094) {
        return res.status(400).json({ error: "VLAN ID must be 2-4094" });
      }
      const result = await evalSwitchCommand(prisma, "switch_create_vlan", { vlan_id, name }, req.user?.id);
      if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      await switchClient.createVlan(vlan_id, name || "");
      res.json({ status: "ok", vlan_id });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/switch/vlans/:vlanId", async (req, res, next) => {
    try {
      const vlanId = parseInt(req.params.vlanId);
      if (isNaN(vlanId) || vlanId < 2) {
        return res.status(400).json({ error: "Invalid VLAN ID" });
      }
      if (vlanId === 1) {
        return res.status(403).json({ error: "Cannot delete default VLAN 1" });
      }
      const result = await evalSwitchCommand(prisma, "switch_delete_vlan", { vlan_id: vlanId }, req.user?.id);
      if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      await switchClient.deleteVlan(vlanId);
      res.json({ status: "ok", vlan_id: vlanId, deleted: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/switch/vlans/:vlanId/membership", async (req, res, next) => {
    try {
      const vlanId = parseInt(req.params.vlanId);
      const { ports } = req.body;
      if (!Array.isArray(ports)) {
        return res.status(400).json({ error: "ports must be an array" });
      }
      const result = await evalSwitchCommand(
        prisma, "switch_set_vlan_membership", { vlan_id: vlanId, ports }, req.user?.id
      );
      if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      await switchClient.setVlanMembership(vlanId, ports);
      res.json({ status: "ok", vlan_id: vlanId });
    } catch (err) {
      next(err);
    }
  });

  // --- PoE enable/disable ---

  router.post("/switch/poe/:port/enable", async (req, res, next) => {
    try {
      const port = parseInt(req.params.port);
      if (isNaN(port) || port < 1 || port > 8) {
        return res.status(400).json({ error: "PoE port must be 1-8" });
      }
      const result = await evalSwitchCommand(prisma, "switch_poe_enable", { port }, req.user?.id);
      if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      await switchClient.enablePortPoe(port);
      res.json({ status: "ok", port, poe_enabled: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/switch/poe/:port/disable", async (req, res, next) => {
    try {
      const port = parseInt(req.params.port);
      if (isNaN(port) || port < 1 || port > 8) {
        return res.status(400).json({ error: "PoE port must be 1-8" });
      }
      const result = await evalSwitchCommand(prisma, "switch_poe_disable", { port }, req.user?.id);
      if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      await switchClient.disablePortPoe(port);
      res.json({ status: "ok", port, poe_enabled: false });
    } catch (err) {
      next(err);
    }
  });

  // --- WAN Detection ---

  router.post("/switch/wan/detect", async (req, res, next) => {
    try {
      const result = await evalSwitchCommand(prisma, "switch_wan_detect", {}, req.user?.id);
      if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      const detection = await switchClient.detectWanPort();
      res.json(detection);
    } catch (err) {
      next(err);
    }
  });

  // --- Camera Setup ---

  router.post("/switch/setup/cameras", async (req, res, next) => {
    try {
      const { vlan_id, camera_ports, uplink_ports } = req.body || {};
      const result = await evalSwitchCommand(
        prisma, "switch_setup_cameras",
        { vlan_id: vlan_id || 100, camera_ports: camera_ports || [1,2,3,4,5,6,7,8], uplink_ports: uplink_ports || [9,10] },
        req.user?.id
      );
      if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      const setupResult = await switchClient.setupCameraPorts(vlan_id, camera_ports, uplink_ports);
      res.json(setupResult);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
