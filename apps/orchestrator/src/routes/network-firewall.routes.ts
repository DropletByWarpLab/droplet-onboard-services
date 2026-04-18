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
} from "../services/network.service.js";
import { evaluateNetworkCommand } from "../services/network-safety.service.js";

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

  router.post("/network/firewall/block", async (req, res, next) => {
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

  router.post("/network/firewall/unblock", async (req, res, next) => {
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

  router.post("/network/firewall/port-forward", async (req, res, next) => {
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
}
