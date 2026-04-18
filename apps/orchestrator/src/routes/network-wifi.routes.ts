/**
 * WiFi routes — read settings, scan, and Tier 1/2 writes for SSID,
 * password, and channel.
 */

import type { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  getWifiSettings,
  scanWifiNetworks,
  setWifiSsid,
  setWifiPassword,
  setWifiChannel,
} from "../services/network.service.js";
import { evaluateNetworkCommand } from "../services/network-safety.service.js";

export interface WifiDeps {
  prisma: PrismaClient;
}

export function registerWifiRoutes(router: Router, deps: WifiDeps): void {
  const { prisma } = deps;

  router.get("/network/wifi", async (_req, res, next) => {
    try {
      const wifi = await getWifiSettings();
      res.json(wifi);
    } catch (err) {
      next(err);
    }
  });

  router.get("/network/wifi/scan", async (_req, res, next) => {
    try {
      const results = await scanWifiNetworks();
      res.json({ results });
    } catch (err) {
      next(err);
    }
  });

  router.post("/network/wifi/ssid", async (req, res, next) => {
    try {
      const { radio = "radio0", iface_section = "default_radio0", ssid } = req.body;
      if (!ssid || typeof ssid !== "string") {
        return res.status(400).json({ error: "Missing 'ssid' in request body" });
      }

      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, "wireless.ssid", "set_ssid", { radio, iface_section, ssid }, userId
      );

      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }

      await setWifiSsid(radio, iface_section, ssid);
      res.json({ status: "ok", ssid, tier: result.tier });
    } catch (err) {
      next(err);
    }
  });

  router.post("/network/wifi/password", async (req, res, next) => {
    try {
      const { iface_section = "default_radio0", password } = req.body;
      if (!password || typeof password !== "string") {
        return res.status(400).json({ error: "Missing 'password' in request body" });
      }

      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, "wireless.password", "set_wifi_password", { iface_section, password }, userId
      );

      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          operation: "set_wifi_password",
          tier: result.tier,
          reason: result.reason,
          confirmationToken: result.confirmationToken,
          expiresIn: 60,
        });
      }

      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }

      const op = await setWifiPassword(iface_section, password);
      res.json({ status: "ok", tier: result.tier, operationId: op.operationId });
    } catch (err) {
      next(err);
    }
  });

  router.post("/network/wifi/channel", async (req, res, next) => {
    try {
      const { radio_section = "radio0", channel } = req.body;
      if (channel === undefined) {
        return res.status(400).json({ error: "Missing 'channel' in request body" });
      }

      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, "wireless.channel", "set_channel", { radio_section, channel }, userId
      );

      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }

      const op = await setWifiChannel(radio_section, String(channel));
      res.json({ status: "ok", channel, tier: result.tier, operationId: op.operationId });
    } catch (err) {
      next(err);
    }
  });
}
