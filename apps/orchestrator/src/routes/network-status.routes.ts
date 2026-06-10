/**
 * Network status, device listing, DHCP, system, command-confirm,
 * operation-status, and audit-log routes.
 *
 * Core read surface + Tier 2/3 confirm pipeline. Everything here either
 * reports router state (status / devices / dhcp / system / audit /
 * operations) or drives the cross-cutting confirm flow that the wifi
 * and firewall modules feed into.
 */

import type { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  getNetworkOverview,
  getConnectedDevices,
  getDhcpLeases,
  getSystemInfo,
  addStaticDhcpLease,
  blockDevice,
  unblockDevice,
  addPortForward,
  setWifiPassword,
  rebootRouter,
  getRouterOperation,
} from "../services/network.service.js";
import {
  evaluateNetworkCommand,
  confirmNetworkCommand,
  getNetworkAuditLog,
} from "../services/network-safety.service.js";
import type { createNetworkDeviceService } from "../services/network-device.service.js";
import { handleRegistryError } from "./network-error-handler.js";
import { requireRole } from "../middleware/auth.js";

export interface StatusDeps {
  prisma: PrismaClient;
  networkDeviceService: ReturnType<typeof createNetworkDeviceService>;
}

export function registerStatusRoutes(router: Router, deps: StatusDeps): void {
  const { prisma, networkDeviceService } = deps;

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

  // --- DHCP ---
  router.get("/network/dhcp/leases", async (_req, res, next) => {
    try {
      const leases = await getDhcpLeases();
      res.json({ leases });
    } catch (err) {
      next(err);
    }
  });

  // WARP-171: per-route guard. owner + admin only — DHCP static
  // leases shape the LAN's address map.
  router.post(
    "/network/dhcp/static-lease",
    requireRole("owner", "admin"),
    async (req, res, next) => {
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
    },
  );

  // --- System ---
  router.get("/network/system", async (_req, res, next) => {
    try {
      const info = await getSystemInfo();
      res.json(info);
    } catch (err) {
      next(err);
    }
  });

  // WARP-171: per-route guard. owner ONLY — rebooting the router is
  // a destructive operation that drops every connected device. The
  // matrix carves this out as owner-only ("the household admin can't
  // do this without confirmation from the install-time owner"). For
  // the moment we encode that as a single-role allow; if a future
  // ticket adds an MFA gate (WARP-230/238) it layers on top of this.
  router.post("/network/system/reboot", requireRole("owner"), async (req, res, next) => {
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
  // Human-only by design, mirroring /switch/command/confirm: with the MCP
  // principal admitted to the Tier-2 mint routes (requireRoleOrMcpService),
  // an unguarded confirm would let that principal consume its OWN token —
  // confirmNetworkCommand's user-match check passes when minter and
  // confirmer are the same id — and execute the write with no human in the
  // loop. Every mint route is owner/admin (reboot owner-only), so
  // owner/admin is the complete legitimate caller set.
  router.post("/network/command/confirm", requireRole("owner", "admin"), async (req, res, next) => {
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
          // WARP-808 review #2: the Tier-2 confirm runs in a SEPARATE request
          // from the original /wifi/ssid stage; pass the same authenticated
          // userId so applyWifi consumes THIS user's staged SSID (single-box
          // hostapd path) rather than a process-global slot.
          writeResult = await setWifiPassword(
            (params?.iface_section as string) || "default_radio0",
            params?.password as string,
            userId
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
}
