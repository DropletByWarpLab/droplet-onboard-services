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
  getRouterOperation,
  isNetworkInitialized,
} from "../services/network.service.js";
import {
  evaluateNetworkCommand,
  confirmNetworkCommand,
  getNetworkAuditLog,
} from "../services/network-safety.service.js";
import { createNetworkDeviceService } from "../services/network-device.service.js";
import { createScheduleApiService } from "../services/schedule-api.service.js";
import * as openwrt from "../services/openwrt.client.js";
import { DeviceRegistryError } from "../types/device-registry-error.js";

const logger = pino({ name: "network-routes" });

export function createNetworkRouter(prisma: PrismaClient): Router {
  const router = Router();

  // --- WARP-82: device-registry service ---
  // Fed a live routing-service snapshot (DHCP + wireless) so listDevices can
  // enrich the NetworkDevice rows with current signal strength. If the
  // router is unreachable we fail soft to an empty snapshot — the
  // dashboard still renders last-known state, just without signal bars.
  const networkDeviceService = createNetworkDeviceService(prisma, async () => {
    try {
      const [leases, wirelessClients] = await Promise.all([
        openwrt.fetchDhcpLeases().catch(() => []),
        openwrt.fetchWirelessClients().catch(() => []),
      ]);
      return {
        leases: leases.map((l) => ({
          mac: l.macaddr,
          ip: l.ipaddr,
          hostname: l.hostname,
        })),
        wirelessClients: wirelessClients.map((w) => ({
          mac: w.mac,
          signal: w.signal,
        })),
      };
    } catch {
      return { leases: [], wirelessClients: [] };
    }
  });

  // --- WARP-94: schedule + override + manualBlock REST surface ---
  // Thin wrapper over Prisma; enforces subject/window/range invariants
  // and translates P2025 to typed DeviceRegistryError. See service file
  // for the full invariant list — route handlers only do thin
  // arg-marshalling and error mapping.
  const scheduleApi = createScheduleApiService(prisma);

  function handleRegistryError(err: unknown, res: any, next: any): void {
    if (err instanceof DeviceRegistryError) {
      res.status(err.status ?? 400).json({ error: err.toJSON() });
      return;
    }
    next(err);
  }

  // --- Network overview ---
  router.get("/network/status", async (_req, res, next) => {
    try {
      // WARP-39: typed Result — on error, surface the RouterError code to the
      // dashboard so it can render per-code messaging instead of a generic
      // "Router Not Connected".
      const result = await getNetworkOverview();
      if (result.ok) {
        res.json(result.value);
      } else {
        res.status(503).json({ error: result.error.toJSON() });
      }
    } catch (err) {
      next(err);
    }
  });

  // --- WARP-82: enriched device registry ---
  // Replaces the old DHCP-lease passthrough with the joined NetworkDevice
  // view (displayName, icon, notes, groups, online flag, signal). Callers
  // that still want the raw connected-devices snapshot can opt in via
  // `?legacy=1` — kept for one release while clients migrate.
  router.get("/network/devices", async (req, res, next) => {
    try {
      if (req.query.legacy === "1") {
        const devices = await getConnectedDevices();
        return res.json({ devices });
      }
      const devices = await networkDeviceService.listDevices({
        onlineOnly: req.query.onlineOnly === "1",
        groupId:
          typeof req.query.groupId === "string" ? req.query.groupId : undefined,
      });
      res.json({ devices });
    } catch (err) {
      handleRegistryError(err, res, next);
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

      const op = await addStaticDhcpLease(name, mac, ip);
      res.json({ status: "ok", name, mac, ip, tier: result.tier, operationId: op.operationId });
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

      const op = await rebootRouter();
      res.json({ status: "ok", action: "reboot", operationId: op.operationId });
    } catch (err) {
      next(err);
    }
  });

  // --- Confirm Tier 2/3 network command ---
  router.post("/network/command/confirm", async (req, res, next) => {
    try {
      const { confirmationToken, operation, entityId } = req.body;
      if (!confirmationToken || typeof confirmationToken !== "string") {
        return res.status(400).json({ error: "Missing 'confirmationToken'", code: "TOKEN_MISSING" });
      }
      // WARP-41: require callers to echo the operation they think they're confirming.
      // The dashboard receives it in the 202 response and hands it back unchanged.
      if (!operation || typeof operation !== "string") {
        return res.status(400).json({
          error: "Missing 'operation' — clients must echo the operation from the 202 response",
          code: "TOKEN_OPERATION_MISMATCH",
        });
      }

      const userId = req.user?.id;
      const expected: { operation: string; entityId?: string } = { operation };
      if (typeof entityId === "string" && entityId.length > 0) {
        expected.entityId = entityId;
      }

      const result = await confirmNetworkCommand(prisma, confirmationToken, userId, expected);

      if (!result.confirmed) {
        return res.status(400).json({ error: result.reason, code: result.code });
      }

      // Execute the confirmed command — use the confirmed operation from the
      // pending record, which we already validated matches the caller's echo.
      const { operation: confirmedOp, params } = result;
      let writeResult: { operationId: string | null };
      switch (confirmedOp) {
        case "block_device":
          writeResult = await blockDevice(params?.mac as string, params?.name as string | undefined);
          break;
        case "unblock_device":
          writeResult = await unblockDevice(params?.mac as string);
          break;
        case "add_port_forward":
          writeResult = await addPortForward(
            params?.name as string,
            params?.src_port as string,
            params?.dest_ip as string,
            params?.dest_port as string,
            (params?.proto as string) || "tcp"
          );
          break;
        case "set_wifi_password":
          writeResult = await setWifiPassword(
            (params?.iface_section as string) || "default_radio0",
            params?.password as string
          );
          break;
        case "reboot":
          writeResult = await rebootRouter();
          break;
        default:
          return res.status(400).json({ error: `Unknown operation: ${confirmedOp}` });
      }

      // WARP-40: surface the Operation-Id so the dashboard can poll for
      // apply-vs-rollback outcome without re-reading the target resource.
      res.json({
        status: "ok",
        operation: confirmedOp,
        confirmed: true,
        operationId: writeResult.operationId,
      });
    } catch (err) {
      next(err);
    }
  });

  // --- Operation status (WARP-40) ---
  // Dashboard polls this after any Tier 2 confirm or direct write to learn
  // whether the router accepted the change or rolled it back.
  router.get("/network/operations/:id", async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!id || id.length > 64) {
        return res.status(400).json({ error: "Invalid operation id" });
      }
      try {
        const op = await getRouterOperation(id);
        res.json(op);
      } catch (err) {
        // fetchOperation throws "Operation lookup: 404 ..." when the id is
        // unknown or expired. Surface as 404 to the dashboard.
        if (err instanceof Error && /:\s*404/.test(err.message)) {
          return res.status(404).json({ error: "Operation not found or expired" });
        }
        throw err;
      }
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

  // --- WARP-82: single device + mutations ---

  router.get("/network/devices/:mac", async (req, res, next) => {
    try {
      const result = await networkDeviceService.getDevice(req.params.mac);
      res.json(result);
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.patch("/network/devices/:mac", async (req, res, next) => {
    try {
      const { displayName, icon, notes } = req.body ?? {};
      const patch: { displayName?: string; icon?: string; notes?: string } = {};
      if (displayName !== undefined) {
        if (typeof displayName !== "string") {
          return res.status(400).json({ error: "displayName must be a string" });
        }
        patch.displayName = displayName;
      }
      if (icon !== undefined) {
        if (typeof icon !== "string") {
          return res.status(400).json({ error: "icon must be a string" });
        }
        patch.icon = icon;
      }
      if (notes !== undefined) {
        if (typeof notes !== "string") {
          return res.status(400).json({ error: "notes must be a string" });
        }
        patch.notes = notes;
      }
      const device = await networkDeviceService.updateDevice(req.params.mac, patch);
      res.json({ device });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.post("/network/devices/:mac/groups", async (req, res, next) => {
    try {
      const { groupIds } = req.body ?? {};
      if (!Array.isArray(groupIds) || !groupIds.every((x) => typeof x === "string")) {
        return res
          .status(400)
          .json({ error: "Body must be { groupIds: string[] }" });
      }
      const device = await networkDeviceService.assignDeviceGroups(
        req.params.mac,
        groupIds,
      );
      res.json({ device });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.delete("/network/devices/:mac", async (req, res, next) => {
    try {
      await networkDeviceService.forgetDevice(req.params.mac);
      res.status(204).end();
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  // --- WARP-82: groups ---

  router.get("/network/groups", async (_req, res, next) => {
    try {
      const groups = await networkDeviceService.listGroups();
      res.json({ groups });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.post("/network/groups", async (req, res, next) => {
    try {
      const { name, color, icon } = req.body ?? {};
      if (typeof name !== "string" || name.trim().length === 0) {
        return res.status(400).json({ error: "name is required" });
      }
      if (color !== undefined && typeof color !== "string") {
        return res.status(400).json({ error: "color must be a string" });
      }
      if (icon !== undefined && typeof icon !== "string") {
        return res.status(400).json({ error: "icon must be a string" });
      }
      const group = await networkDeviceService.createGroup(name, color, icon);
      res.status(201).json({ group });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.patch("/network/groups/:id", async (req, res, next) => {
    try {
      const { name, color, icon } = req.body ?? {};
      const patch: { name?: string; color?: string; icon?: string } = {};
      if (name !== undefined) {
        if (typeof name !== "string") {
          return res.status(400).json({ error: "name must be a string" });
        }
        patch.name = name;
      }
      if (color !== undefined) {
        if (typeof color !== "string") {
          return res.status(400).json({ error: "color must be a string" });
        }
        patch.color = color;
      }
      if (icon !== undefined) {
        if (typeof icon !== "string") {
          return res.status(400).json({ error: "icon must be a string" });
        }
        patch.icon = icon;
      }
      const group = await networkDeviceService.renameGroup(req.params.id, patch);
      res.json({ group });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.delete("/network/groups/:id", async (req, res, next) => {
    try {
      await networkDeviceService.deleteGroup(req.params.id);
      res.status(204).end();
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  // --- WARP-94: schedules + overrides + schedule events ---
  // Everything below is a thin HTTP shell over `scheduleApi`. The service
  // is the one enforcing subject/window/range invariants; the only
  // marshalling these handlers do is ISO-string → Date for the override
  // endpoints.

  router.get("/network/schedules", async (_req, res, next) => {
    try {
      const schedules = await scheduleApi.listSchedules();
      res.json({ schedules });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.get("/network/schedules/:id", async (req, res, next) => {
    try {
      const schedule = await scheduleApi.getSchedule(req.params.id);
      res.json({ schedule });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.post("/network/schedules", async (req, res, next) => {
    try {
      const schedule = await scheduleApi.createSchedule(req.body);
      res.status(201).json({ schedule });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.patch("/network/schedules/:id", async (req, res, next) => {
    try {
      const schedule = await scheduleApi.updateSchedule(
        req.params.id,
        req.body ?? {},
      );
      res.json({ schedule });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.delete("/network/schedules/:id", async (req, res, next) => {
    try {
      await scheduleApi.deleteSchedule(req.params.id);
      res.status(204).end();
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.get("/network/overrides", async (req, res, next) => {
    try {
      const overrides = await scheduleApi.listOverrides({
        active: req.query.active === "1",
        deviceMac:
          typeof req.query.deviceMac === "string"
            ? req.query.deviceMac
            : undefined,
        groupId:
          typeof req.query.groupId === "string"
            ? req.query.groupId
            : undefined,
      });
      res.json({ overrides });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.post("/network/overrides", async (req, res, next) => {
    try {
      const body = { ...(req.body ?? {}) };
      // Guard against `new Date("not-a-date")` silently yielding Invalid Date —
      // `getTime()` on Invalid Date returns NaN, which makes every range
      // comparison in the service layer (`endAt <= startAt`) resolve false
      // and write a corrupt row. Reject at the edge before the service sees it.
      if (body.startAt !== undefined) {
        const d = new Date(body.startAt);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({
            error: DeviceRegistryError.invalidDate(
              "startAt",
              String(body.startAt),
            ).toJSON(),
          });
        }
        body.startAt = d;
      }
      if (body.endAt !== undefined) {
        const d = new Date(body.endAt);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({
            error: DeviceRegistryError.invalidDate(
              "endAt",
              String(body.endAt),
            ).toJSON(),
          });
        }
        body.endAt = d;
      }
      const override = await scheduleApi.createOverride(body);
      res.status(201).json({ override });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.delete("/network/overrides/:id", async (req, res, next) => {
    try {
      await scheduleApi.cancelOverride(req.params.id);
      res.status(204).end();
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.get("/network/schedule-events", async (req, res, next) => {
    try {
      let since: Date | undefined;
      if (typeof req.query.since === "string") {
        const d = new Date(req.query.since);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({
            error: DeviceRegistryError.invalidDate(
              "since",
              req.query.since,
            ).toJSON(),
          });
        }
        since = d;
      }
      const events = await scheduleApi.listScheduleEvents({
        since,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.json({ events });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.post("/network/devices/:mac/manualBlock", async (req, res, next) => {
    try {
      if (typeof req.body?.blocked !== "boolean") {
        return res
          .status(400)
          .json({ error: "Body must be { blocked: boolean }" });
      }
      const result = await scheduleApi.setManualBlock(
        req.params.mac,
        req.body.blocked,
      );
      res.json(result);
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  return router;
}
