/**
 * Firewall routes — config readout plus Tier 2 block / unblock /
 * port-forward writes. All mutations flow through the network-safety
 * evaluator and may return a 202 `confirmation_required`.
 */

import type { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  getFirewallConfig,
  blockDevice,
  unblockDevice,
  addPortForward,
  addFirewallRule,
  setZonePolicy,
  getUpnp,
  setUpnp,
} from "../services/network.service.js";
import { evaluateNetworkCommand } from "../services/network-safety.service.js";
import { requireRole, requireRoleOrMcpService } from "../middleware/auth.js";

export interface FirewallDeps {
  prisma: PrismaClient;
}

export function registerFirewallRoutes(router: Router, deps: FirewallDeps): void {
  const { prisma } = deps;

  router.get("/network/firewall", async (_req, res, next) => {
    try {
      const config = await getFirewallConfig();
      res.json(config);
    } catch (err) {
      next(err);
    }
  });

  // UPnP / NAT-PMP read — reflects the box's real state. available=false means
  // miniupnpd isn't installed (the secure default for a privacy appliance).
  router.get("/network/upnp", async (_req, res, next) => {
    try {
      res.json(await getUpnp());
    } catch (err) {
      next(err);
    }
  });

  // UPnP / NAT-PMP write — owner/admin only, Tier 2 (set_upnp). Turning on
  // automatic port opening can expose LAN services to the internet, so it
  // routes through the safety evaluator like the other firewall-class writes.
  // No MCP principal: there is no set_upnp tool, and opening firewall holes is a
  // deliberate human action, not an AI-driven one (mirrors the guest routes).
  router.post("/network/upnp", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "`enabled` must be a boolean" });
      }

      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, "firewall.upnp", "set_upnp", { enabled }, userId
      );

      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          operation: "set_upnp",
          tier: result.tier,
          reason: result.reason,
          confirmationToken: result.confirmationToken,
          expiresIn: 60,
        });
      }

      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }

      const op = await setUpnp(enabled);
      res.json({ status: "ok", enabled, tier: result.tier, operationId: op.operationId });
    } catch (err) {
      next(err);
    }
  });

  // WARP-171: per-route guard. owner + admin only — blocking a device
  // cuts a household member's connectivity, so this stays in the
  // household-admin tier even though the network-safety evaluator
  // also gates it via the tier system. The MCP principal is admitted
  // so the block_network_device tool reaches that evaluator — Tier 2
  // still answers 202, never executes.
  router.post("/network/firewall/block", requireRoleOrMcpService("owner", "admin"), async (req, res, next) => {
    try {
      const { mac, name } = req.body;
      if (!mac || typeof mac !== "string") {
        return res.status(400).json({ error: "Missing 'mac' in request body" });
      }

      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, `firewall.block.${mac}`, "block_device", { mac, name }, userId
      );

      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          operation: "block_device",
          mac,
          tier: result.tier,
          reason: result.reason,
          confirmationToken: result.confirmationToken,
          expiresIn: 60,
        });
      }

      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }

      const op = await blockDevice(mac, name);
      res.json({ status: "ok", mac, action: "blocked", tier: result.tier, operationId: op.operationId });
    } catch (err) {
      next(err);
    }
  });

  // WARP-171: per-route guard. owner + admin only, plus the MCP
  // principal (unblock_network_device tool — Tier 2, 202 only).
  router.post("/network/firewall/unblock", requireRoleOrMcpService("owner", "admin"), async (req, res, next) => {
    try {
      const { mac } = req.body;
      if (!mac || typeof mac !== "string") {
        return res.status(400).json({ error: "Missing 'mac' in request body" });
      }

      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, `firewall.unblock.${mac}`, "unblock_device", { mac }, userId
      );

      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          operation: "unblock_device",
          mac,
          tier: result.tier,
          reason: result.reason,
          confirmationToken: result.confirmationToken,
          expiresIn: 60,
        });
      }

      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }

      const op = await unblockDevice(mac);
      res.json({ status: "ok", mac, action: "unblocked", tier: result.tier, operationId: op.operationId });
    } catch (err) {
      next(err);
    }
  });

  // WARP-171: per-route guard. owner + admin only — port-forwarding
  // exposes a LAN service to the public internet; never a family-tier
  // operation. The MCP principal is admitted for the add_port_forward
  // tool — Tier 2, 202 only.
  router.post("/network/firewall/port-forward", requireRoleOrMcpService("owner", "admin"), async (req, res, next) => {
    try {
      const { name, src_port, dest_ip, dest_port, proto = "tcp" } = req.body;
      if (!name || !src_port || !dest_ip || !dest_port) {
        return res.status(400).json({ error: "Missing required port forward fields" });
      }

      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, `firewall.redirect.${name}`, "add_port_forward",
        { name, src_port, dest_ip, dest_port, proto }, userId
      );

      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          operation: "add_port_forward",
          name,
          tier: result.tier,
          reason: result.reason,
          confirmationToken: result.confirmationToken,
          expiresIn: 60,
        });
      }

      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }

      const op = await addPortForward(name, src_port, dest_ip, dest_port, proto);
      res.json({ status: "ok", name, tier: result.tier, operationId: op.operationId });
    } catch (err) {
      next(err);
    }
  });

  // Add a generic firewall traffic rule — owner/admin, Tier 2. MCP principal
  // admitted to reach the evaluator (202 only) for symmetry with the other
  // firewall writes, though there is no add_firewall_rule AI tool today.
  router.post("/network/firewall/rule", requireRoleOrMcpService("owner", "admin"), async (req, res, next) => {
    try {
      const { name, src, dest, proto = "tcp", dest_port, src_port, target = "REJECT", enabled = "1" } = req.body;
      if (!name || !src || !dest) {
        return res.status(400).json({ error: "Missing required rule fields (name, src, dest)" });
      }
      if (!["ACCEPT", "REJECT", "DROP"].includes(target)) {
        return res.status(400).json({ error: "target must be ACCEPT, REJECT or DROP" });
      }

      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, `firewall.rule.${name}`, "add_firewall_rule",
        { name, src, dest, proto, dest_port, src_port, target, enabled }, userId
      );

      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          operation: "add_firewall_rule",
          name,
          tier: result.tier,
          reason: result.reason,
          confirmationToken: result.confirmationToken,
          expiresIn: 60,
        });
      }
      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }

      const op = await addFirewallRule({ name, src, dest, proto, destPort: dest_port, srcPort: src_port, target, enabled });
      res.json({ status: "ok", name, tier: result.tier, operationId: op.operationId });
    } catch (err) {
      next(err);
    }
  });

  // Set a zone's default input/output/forward policy — owner/admin, Tier 2.
  // NO MCP principal: rewriting a zone default policy is a deliberate human
  // action (it can sever management), like guest/upnp.
  router.post("/network/firewall/zone-policy", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const { zone, input, output, forward } = req.body;
      if (!zone || typeof zone !== "string") {
        return res.status(400).json({ error: "Missing 'zone' in request body" });
      }
      for (const p of [input, output, forward]) {
        if (p !== undefined && !["ACCEPT", "REJECT", "DROP"].includes(p)) {
          return res.status(400).json({ error: "policy must be ACCEPT, REJECT or DROP" });
        }
      }
      if (input === undefined && output === undefined && forward === undefined) {
        return res.status(400).json({ error: "Provide at least one of input, output, forward" });
      }

      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, `firewall.zone.${zone}`, "set_zone_policy",
        { zone, input, output, forward }, userId
      );

      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          operation: "set_zone_policy",
          zone,
          tier: result.tier,
          reason: result.reason,
          confirmationToken: result.confirmationToken,
          expiresIn: 60,
        });
      }
      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }

      const op = await setZonePolicy({ zone, input, output, forward });
      res.json({ status: "ok", zone, tier: result.tier, operationId: op.operationId });
    } catch (err) {
      next(err);
    }
  });
}
