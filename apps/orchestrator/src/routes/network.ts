/**
 * Network API routes — router status, WiFi, DHCP, firewall, and system control.
 *
 * Commands are evaluated through the network safety tier framework:
 * - Tier 1: Auto-execute (reads, SSID, channel, DNS, static lease)
 * - Tier 2: Requires user confirmation (firewall, password, WAN config)
 * - Tier 3: Blocked for AI, web UI only (reboot, VPN)
 */

import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import pino from "pino";
import {
  getNetworkOverview,
  getConnectedDevices,
  getWifiSettings,
  scanWifiNetworks,
  getDhcpLeases,
  getFirewallConfig,
  getSystemInfo,
  setWifiSsid,
  setWifiPassword,
  setWifiChannel,
  addStaticDhcpLease,
  blockDevice,
  unblockDevice,
  addPortForward,
  rebootRouter,
  isNetworkInitialized,
} from "../services/network.service.js";
import {
  evaluateNetworkCommand,
  confirmNetworkCommand,
  getNetworkAuditLog,
} from "../services/network-safety.service.js";

const logger = pino({ name: "network-routes" });

export function createNetworkRouter(prisma: PrismaClient): Router {
  const router = Router();

  // --- Network overview ---
  router.get("/network/status", async (_req, res, next) => {
    try {
      const overview = await getNetworkOverview();
      res.json(overview);
    } catch (err) {
      next(err);
    }
  });

  // --- Connected devices ---
  router.get("/network/devices", async (_req, res, next) => {
    try {
      const devices = await getConnectedDevices();
      res.json({ devices });
    } catch (err) {
      next(err);
    }
  });

  // --- SSE stream for device changes (poll-based) ---
  router.get("/network/devices/events", async (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

    let lastDeviceJson = "";

    const pollInterval = setInterval(async () => {
      try {
        const devices = await getConnectedDevices();
        const currentJson = JSON.stringify(devices);
        if (currentJson !== lastDeviceJson) {
          lastDeviceJson = currentJson;
          res.write(`data: ${JSON.stringify({ type: "devices_changed", devices })}\n\n`);
        }
      } catch {
        // Non-fatal
      }
    }, 10_000);

    const heartbeat = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 30_000);

    req.on("close", () => {
      clearInterval(pollInterval);
      clearInterval(heartbeat);
    });
  });

  // --- WiFi ---
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

      await setWifiPassword(iface_section, password);
      res.json({ status: "ok", tier: result.tier });
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

      await setWifiChannel(radio_section, String(channel));
      res.json({ status: "ok", channel, tier: result.tier });
    } catch (err) {
      next(err);
    }
  });

  // --- DHCP ---
  router.get("/network/dhcp/leases", async (_req, res, next) => {
    try {
      const leases = await getDhcpLeases();
      res.json({ leases });
    } catch (err) {
      next(err);
    }
  });

  router.post("/network/dhcp/static-lease", async (req, res, next) => {
    try {
      const { name, mac, ip } = req.body;
      if (!name || !mac || !ip) {
        return res.status(400).json({ error: "Missing 'name', 'mac', or 'ip'" });
      }

      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, "dhcp.static_lease", "add_static_lease", { name, mac, ip }, userId
      );

      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }

      await addStaticDhcpLease(name, mac, ip);
      res.json({ status: "ok", name, mac, ip, tier: result.tier });
    } catch (err) {
      next(err);
    }
  });

  // --- Firewall ---
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

      await blockDevice(mac, name);
      res.json({ status: "ok", mac, action: "blocked", tier: result.tier });
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

      await unblockDevice(mac);
      res.json({ status: "ok", mac, action: "unblocked", tier: result.tier });
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

      await addPortForward(name, src_port, dest_ip, dest_port, proto);
      res.json({ status: "ok", name, tier: result.tier });
    } catch (err) {
      next(err);
    }
  });

  // --- System ---
  router.get("/network/system", async (_req, res, next) => {
    try {
      const info = await getSystemInfo();
      res.json(info);
    } catch (err) {
      next(err);
    }
  });

  router.post("/network/system/reboot", async (req, res, next) => {
    try {
      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, "system.reboot", "reboot", {}, userId, "api"
      );

      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          operation: "reboot",
          tier: result.tier,
          reason: result.reason,
          confirmationToken: result.confirmationToken,
          expiresIn: 60,
        });
      }

      if ("blocked" in result && result.blocked) {
        return res.status(403).json({ error: result.reason, tier: result.tier, blocked: true });
      }

      await rebootRouter();
      res.json({ status: "ok", action: "reboot" });
    } catch (err) {
      next(err);
    }
  });

  // --- Confirm Tier 2/3 network command ---
  router.post("/network/command/confirm", async (req, res, next) => {
    try {
      const { confirmationToken } = req.body;
      if (!confirmationToken || typeof confirmationToken !== "string") {
        return res.status(400).json({ error: "Missing 'confirmationToken'" });
      }

      const userId = req.user?.id;
      const result = await confirmNetworkCommand(prisma, confirmationToken, userId);

      if (!result.confirmed) {
        return res.status(400).json({ error: result.reason });
      }

      // Execute the confirmed command
      const { operation, params } = result;
      switch (operation) {
        case "block_device":
          await blockDevice(params?.mac as string, params?.name as string | undefined);
          break;
        case "unblock_device":
          await unblockDevice(params?.mac as string);
          break;
        case "add_port_forward":
          await addPortForward(
            params?.name as string,
            params?.src_port as string,
            params?.dest_ip as string,
            params?.dest_port as string,
            (params?.proto as string) || "tcp"
          );
          break;
        case "set_wifi_password":
          await setWifiPassword(
            (params?.iface_section as string) || "default_radio0",
            params?.password as string
          );
          break;
        case "reboot":
          await rebootRouter();
          break;
        default:
          return res.status(400).json({ error: `Unknown operation: ${operation}` });
      }

      res.json({ status: "ok", operation, confirmed: true });
    } catch (err) {
      next(err);
    }
  });

  // --- Audit log ---
  router.get("/network/audit", async (req, res, next) => {
    try {
      const { entityId, userId, limit, offset } = req.query;
      const effectiveUserId = (userId as string | undefined) || req.user?.id;
      const effectiveLimit = Math.min(limit ? parseInt(limit as string, 10) : 50, 500);
      const logs = await getNetworkAuditLog(prisma, {
        entityId: entityId as string | undefined,
        userId: effectiveUserId,
        limit: effectiveLimit,
        offset: offset ? parseInt(offset as string, 10) : undefined,
      });
      res.json({ logs });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
