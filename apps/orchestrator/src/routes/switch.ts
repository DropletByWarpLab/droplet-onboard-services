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
 * to the hardware via the active driver (pluggable backend; prototype
 * uses the managed switch driver, production may use a custom ASIC).
 */

import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import pino from "pino";
import * as switchClient from "../services/switch.client.js";
import {
  evaluateNetworkCommand,
  confirmNetworkCommand,
} from "../services/network-safety.service.js";
import { requireRole } from "../middleware/auth.js";

const logger = pino({ name: "switch-routes" });

/**
 * Protected port: the port the appliance is connected to.
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

/**
 * Resolve the authenticated user id on a mutating switch route.
 *
 * WARP-559: every mutating route below now sits behind
 * `requireRole("owner", "admin")`, which runs after `authMiddleware`.
 * Reaching a handler therefore guarantees an authenticated session with a
 * populated `req.user.id`. `evalSwitchCommand` is the WARP-76
 * safety/confirmation/audit tier — a complementary layer, NOT the
 * authorization gate — and it previously tolerated `req.user?.id` being
 * `undefined`. With the guard in place a missing id is no longer a benign
 * client condition; it would be a middleware-ordering bug. Assert it here
 * rather than silently forwarding `undefined` downstream.
 */
function requireUserId(userId: string | undefined): string {
  if (typeof userId !== "string" || userId.length === 0) {
    // Defense in depth: requireRole already 403s a session with no role,
    // and authMiddleware 401s a request with no session. An empty id at
    // this point means the guard chain was bypassed — fail loud so it
    // surfaces via the error handler (500) instead of writing an
    // unattributed switch mutation.
    throw new Error("switch route reached without an authenticated user id");
  }
  return userId;
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
  // WARP-559: owner+admin only — confirming a queued token EXECUTES the
  // mutation, so it must carry the same guard as the routes that mint the
  // token, or it becomes an unguarded execution bypass.
  router.post("/switch/command/confirm", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const userId = requireUserId(req.user?.id);
      const { confirmationToken } = req.body;
      if (!confirmationToken) {
        return res.status(400).json({ error: "Missing confirmationToken" });
      }
      const result = await confirmNetworkCommand(prisma, confirmationToken, userId);
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
        case "switch_disable_protected_port":
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

  router.post("/switch/ports/:port/enable", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const userId = requireUserId(req.user?.id);
      const port = parseInt(req.params.port);
      if (isNaN(port) || port < 1 || port > 10) {
        return res.status(400).json({ error: "Invalid port number" });
      }
      const result = await evalSwitchCommand(prisma, "switch_port_enable", { port }, userId);
      if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      await switchClient.enablePort(port);
      res.json({ status: "ok", port, enabled: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/switch/ports/:port/disable", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const userId = requireUserId(req.user?.id);
      const port = parseInt(req.params.port);
      if (isNaN(port) || port < 1 || port > 10) {
        return res.status(400).json({ error: "Invalid port number" });
      }
      // Protected port: block AI entirely, require confirmation for web UI
      if (isProtectedPort(port)) {
        const result = await evalSwitchCommand(
          prisma, "switch_disable_protected_port", { port }, userId
        );
        if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      } else {
        const result = await evalSwitchCommand(prisma, "switch_port_disable", { port }, userId);
        if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      }
      await switchClient.disablePort(port);
      res.json({ status: "ok", port, enabled: false });
    } catch (err) {
      next(err);
    }
  });

  // --- VLAN create/delete/membership ---

  router.post("/switch/vlans", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const userId = requireUserId(req.user?.id);
      const { vlan_id, name } = req.body;
      if (!vlan_id || vlan_id < 2 || vlan_id > 4094) {
        return res.status(400).json({ error: "VLAN ID must be 2-4094" });
      }
      const result = await evalSwitchCommand(prisma, "switch_create_vlan", { vlan_id, name }, userId);
      if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      await switchClient.createVlan(vlan_id, name || "");
      res.json({ status: "ok", vlan_id });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/switch/vlans/:vlanId", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const userId = requireUserId(req.user?.id);
      const vlanId = parseInt(req.params.vlanId);
      if (isNaN(vlanId) || vlanId < 2) {
        return res.status(400).json({ error: "Invalid VLAN ID" });
      }
      if (vlanId === 1) {
        return res.status(403).json({ error: "Cannot delete default VLAN 1" });
      }
      const result = await evalSwitchCommand(prisma, "switch_delete_vlan", { vlan_id: vlanId }, userId);
      if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      await switchClient.deleteVlan(vlanId);
      res.json({ status: "ok", vlan_id: vlanId, deleted: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/switch/vlans/:vlanId/membership", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const userId = requireUserId(req.user?.id);
      const vlanId = parseInt(req.params.vlanId);
      const { ports } = req.body;
      if (!Array.isArray(ports)) {
        return res.status(400).json({ error: "ports must be an array" });
      }
      const result = await evalSwitchCommand(
        prisma, "switch_set_vlan_membership", { vlan_id: vlanId, ports }, userId
      );
      if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      await switchClient.setVlanMembership(vlanId, ports);
      res.json({ status: "ok", vlan_id: vlanId });
    } catch (err) {
      next(err);
    }
  });

  // --- PoE enable/disable ---

  router.post("/switch/poe/:port/enable", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const userId = requireUserId(req.user?.id);
      const port = parseInt(req.params.port);
      if (isNaN(port) || port < 1 || port > 8) {
        return res.status(400).json({ error: "PoE port must be 1-8" });
      }
      const result = await evalSwitchCommand(prisma, "switch_poe_enable", { port }, userId);
      if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      await switchClient.enablePortPoe(port);
      res.json({ status: "ok", port, poe_enabled: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/switch/poe/:port/disable", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const userId = requireUserId(req.user?.id);
      const port = parseInt(req.params.port);
      if (isNaN(port) || port < 1 || port > 8) {
        return res.status(400).json({ error: "PoE port must be 1-8" });
      }
      const result = await evalSwitchCommand(prisma, "switch_poe_disable", { port }, userId);
      if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      await switchClient.disablePortPoe(port);
      res.json({ status: "ok", port, poe_enabled: false });
    } catch (err) {
      next(err);
    }
  });

  // --- WAN Detection ---

  router.post("/switch/wan/detect", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const userId = requireUserId(req.user?.id);
      const result = await evalSwitchCommand(prisma, "switch_wan_detect", {}, userId);
      if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      const detection = await switchClient.detectWanPort();
      res.json(detection);
    } catch (err) {
      next(err);
    }
  });

  // --- Camera Setup ---

  router.post("/switch/setup/cameras", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const userId = requireUserId(req.user?.id);
      const { vlan_id, camera_ports, uplink_ports } = req.body || {};
      const result = await evalSwitchCommand(
        prisma, "switch_setup_cameras",
        { vlan_id: vlan_id || 100, camera_ports: camera_ports || [1,2,3,4,5,6,7,8], uplink_ports: uplink_ports || [9,10] },
        userId
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
