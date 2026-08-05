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
  getAllInterfaces,
  addStaticDhcpLease,
  setDnsServers,
  getTopology,
  getDnsHostnames,
  addDnsHostname,
  deleteDnsHostname,
  getDhcpPool,
  setDhcpPool,
  getSystemControls,
  setHostname,
  setNtpEnabled,
  blockDevice,
  unblockDevice,
  addPortForward,
  addFirewallRule,
  setZonePolicy,
  setWifiPassword,
  setGuestWifi,
  setUpnp,
  rebootRouter,
  getRouterOperation,
  getAiNetworkAccess,
  createInterface,
  editInterface,
  restartNetwork,
  getFirmwareCheck,
  assertPrimaryRouterPosture,
  PrimaryRouterRequiredError,
  routerSysupgrade,
  routerFactoryReset,
} from "../services/network.service.js";
import {
  evaluateNetworkCommand,
  confirmNetworkCommand,
  getNetworkAuditLog,
} from "../services/network-safety.service.js";
import type { createNetworkDeviceService } from "../services/network-device.service.js";
// WARP-1703 — band steering is Tier 2, so its write executes on the confirm
// path rather than in the PUT handler.
import { setBandSteering, setApWifi } from "../services/ap-onboard.service.js";
import { handleRegistryError } from "./network-error-handler.js";
import { RouterError } from "../services/openwrt.client.js";
import { requireRole, requireRoleOrMcpService } from "../middleware/auth.js";

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
      // WARP-111: SWR-friendly caching so the dashboard's 15-30s polling
      // can serve a short max-age + revalidate window instead of hammering
      // Prisma on every client tick. Set on both branches of this read.
      res.set("Cache-Control", "private, max-age=5, stale-while-revalidate=10");
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

  // --- Interfaces (full enumeration, read-only) ---
  // Every configured interface (name/device/proto/address/zone/status), not
  // just lan/wan. Kept on its own service read (not the overview hot path).
  router.get("/network/interfaces", async (_req, res, next) => {
    try {
      const interfaces = await getAllInterfaces();
      res.json({ interfaces });
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

  // WARP-871: set the upstream/custom DNS resolvers dnsmasq forwards to (e.g.
  // Pi-hole, NextDNS, 1.1.1.1). owner/admin only — DNS shapes every device's
  // name resolution. set_dns is Tier 1 (low-risk, no partition), so it applies
  // immediately; the routing /dhcp/dns validator only requires a non-empty list.
  router.post(
    "/network/dns",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        const { servers } = req.body;
        if (
          !Array.isArray(servers) ||
          servers.length === 0 ||
          !servers.every((s) => typeof s === "string" && s.trim().length > 0)
        ) {
          return res
            .status(400)
            .json({ error: "Provide 'servers' as a non-empty list of IP strings" });
        }

        const userId = req.user?.id;
        const result = await evaluateNetworkCommand(
          prisma, "dhcp.dns", "set_dns", { servers }, userId
        );

        if ("blocked" in result && result.blocked) {
          return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
        }

        const op = await setDnsServers(servers);
        res.json({ status: "ok", servers, tier: result.tier, operationId: op.operationId });
      } catch (err) {
        next(err);
      }
    },
  );

  // WARP-871: local DNS host-records (e.g. nas.lan -> 192.168.50.20). The
  // routing /dhcp/hostnames endpoints have full read/write/delete; these front
  // them. Reads are open to any authed user; writes are owner/admin and run
  // through the safety evaluator (set/delete_dns_hostname classify Tier 1).
  router.get("/network/dhcp/hostnames", async (_req, res, next) => {
    try {
      const entries = await getDnsHostnames();
      res.json({ entries });
    } catch (err) {
      next(err);
    }
  });

  // --- DHCP pool (range + lease time) ---
  // Read is unguarded; the write is Tier 2 (a LAN address-map change that can
  // strand clients) → 202 + token → /network/command/confirm dispatches it.
  router.get("/network/dhcp/pool", async (_req, res, next) => {
    try {
      const pool = await getDhcpPool();
      res.json(pool);
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/network/dhcp/hostnames",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        const { hostname, ip } = req.body;
        if (
          !hostname ||
          typeof hostname !== "string" ||
          !ip ||
          typeof ip !== "string"
        ) {
          return res.status(400).json({ error: "Missing 'hostname' or 'ip'" });
        }

        const userId = req.user?.id;
        const result = await evaluateNetworkCommand(
          prisma, "dhcp.hostname", "set_dns_hostname", { hostname, ip }, userId
        );

        if ("blocked" in result && result.blocked) {
          return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
        }

        const op = await addDnsHostname(hostname, ip);
        res.json({ status: "ok", hostname, ip, tier: result.tier, operationId: op.operationId });
      } catch (err) {
        next(err);
      }
    },
  );

  // dnsmasq lease-time grammar: positive integer + unit (s/m/h/d/w) or
  // `infinite`. Mirrors the routing DhcpPoolRequest validator so junk is
  // rejected before any router change (and before a token is minted).
  const LEASETIME_RE = /^(infinite|\d+[smhdw])$/;

  router.post(
    "/network/dhcp/pool",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        const { start, limit, leasetime } = req.body ?? {};
        if (
          !Number.isInteger(start) ||
          start < 2 ||
          start > 254 ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 253 ||
          typeof leasetime !== "string" ||
          !LEASETIME_RE.test(leasetime)
        ) {
          return res.status(400).json({
            error:
              "Provide integer 'start' (2-254), integer 'limit' (1-253), and a 'leasetime' like '12h' or 'infinite'",
          });
        }

        const userId = req.user?.id;
        const result = await evaluateNetworkCommand(
          prisma,
          "dhcp.pool",
          "set_dhcp_pool",
          { start, limit, leasetime },
          userId,
        );

        if ("requiresConfirmation" in result && result.requiresConfirmation) {
          return res.status(202).json({
            status: "confirmation_required",
            operation: "set_dhcp_pool",
            tier: result.tier,
            reason: result.reason,
            confirmationToken: result.confirmationToken,
            expiresIn: 60,
          });
        }

        if ("blocked" in result && result.blocked) {
          return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
        }

        const op = await setDhcpPool(start, limit, leasetime);
        res.json({ status: "ok", tier: result.tier, operationId: op.operationId });
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    "/network/dhcp/hostnames/:hostname",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        const { hostname } = req.params;
        if (!hostname) {
          return res.status(400).json({ error: "Missing 'hostname'" });
        }

        const userId = req.user?.id;
        const result = await evaluateNetworkCommand(
          prisma, "dhcp.hostname", "delete_dns_hostname", { hostname }, userId
        );

        if ("blocked" in result && result.blocked) {
          return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
        }

        const op = await deleteDnsHostname(hostname);
        res.json({ status: "ok", hostname, tier: result.tier, operationId: op.operationId });
      } catch (err) {
        next(err);
      }
    },
  );

  // WARP-871: read-only deployment-posture probe (ADR-018). Unguarded read,
  // like /network/status — informs the dashboard's topology badge. A genuine
  // ubus fault propagates so the dashboard can drop the badge rather than
  // assert a posture.
  router.get("/network/topology", async (_req, res, next) => {
    try {
      const topology = await getTopology();
      res.json(topology);
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

  // --- System controls (hostname / NTP / status-LED / country) ---
  // Read carries the honest gates (statusLed.supported / country.editable are
  // forced false on the single-box shape in the service). Hostname is Tier 2
  // (re-keys mDNS/.local → confirm); NTP is Tier 1 (applies immediately).
  router.get("/network/system/controls", async (_req, res, next) => {
    try {
      const controls = await getSystemControls();
      res.json(controls);
    } catch (err) {
      next(err);
    }
  });

  // Same RFC-1123 label grammar as the routing HostnameRequest schema, so a bad
  // hostname is rejected before a token is minted.
  // Multi-label pattern matching the routing service's _HOSTNAME_PATTERN so the
  // orchestrator pre-validation rejects exactly what the routing layer rejects.
  const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

  router.post(
    "/network/system/hostname",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        const { hostname } = req.body ?? {};
        if (typeof hostname !== "string" || hostname.length > 63 || !HOSTNAME_RE.test(hostname)) {
          return res.status(400).json({
            error: "Provide a 'hostname' — lowercase letters, digits and hyphens, max 63 chars",
          });
        }

        const userId = req.user?.id;
        const result = await evaluateNetworkCommand(
          prisma,
          "system.hostname",
          "set_hostname",
          { hostname },
          userId,
        );

        if ("requiresConfirmation" in result && result.requiresConfirmation) {
          return res.status(202).json({
            status: "confirmation_required",
            operation: "set_hostname",
            tier: result.tier,
            reason: result.reason,
            confirmationToken: result.confirmationToken,
            expiresIn: 60,
          });
        }

        if ("blocked" in result && result.blocked) {
          return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
        }

        const op = await setHostname(hostname);
        res.json({ status: "ok", tier: result.tier, operationId: op.operationId });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/network/system/ntp",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        const { enabled } = req.body ?? {};
        if (typeof enabled !== "boolean") {
          return res.status(400).json({ error: "Provide a boolean 'enabled'" });
        }

        const userId = req.user?.id;
        const result = await evaluateNetworkCommand(
          prisma,
          "system.ntp",
          "set_ntp",
          { enabled },
          userId,
        );

        // set_ntp is Tier 1 — applies immediately. Guard the confirm/blocked
        // arms anyway so a future tier bump can't silently no-op.
        if ("requiresConfirmation" in result && result.requiresConfirmation) {
          return res.status(202).json({
            status: "confirmation_required",
            operation: "set_ntp",
            tier: result.tier,
            reason: result.reason,
            confirmationToken: result.confirmationToken,
            expiresIn: 60,
          });
        }

        if ("blocked" in result && result.blocked) {
          return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
        }

        const op = await setNtpEnabled(enabled);
        res.json({ status: "ok", enabled, tier: result.tier, operationId: op.operationId });
      } catch (err) {
        next(err);
      }
    },
  );

  // WARP-171: per-route guard. owner ONLY — rebooting the router is
  // a destructive operation that drops every connected device. The
  // matrix carves this out as owner-only ("the household admin can't
  // do this without confirmation from the install-time owner"). For
  // the moment we encode that as a single-role allow; if a future
  // ticket adds an MFA gate (WARP-230/238) it layers on top of this.
  router.post("/network/system/reboot", requireRoleOrMcpService("owner"), async (req, res, next) => {
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

  // --- KAN-8: router firmware upgrade + factory-reset (PRIMARY_ROUTER only) ---
  //
  // ⚠️ BRICK RISK. `sysupgrade` flashes the router firmware; `factory_reset`
  // wipes the OpenWrt overlay (UCI) and reboots. On the shipping single-box the
  // OpenWrt runs in a container and a wipe destroys the named-volume UCI the host
  // hostapd bridge depends on — there is NO remote recovery. So both writes are:
  //   * owner-only (requireRole("owner") — never the MCP/AI principal);
  //   * Tier-3 (mint a token, execute only on /network/command/confirm);
  //   * HARD-gated to the PRIMARY_ROUTER deployment posture — refused with 409
  //     on the single-box / any non-primary shape, BEFORE a token is minted AND
  //     again at confirm time (assertPrimaryRouterPosture).

  /** Map the PRIMARY_ROUTER gate failure to a 409 the dashboard can render. */
  const sendPrimaryRouterRequired = (res: import("express").Response, err: PrimaryRouterRequiredError) =>
    res.status(409).json({ error: err.message, code: err.code, posture: err.posture });

  // Read-only version compare (AC 4). Safe on any shape — NOT gated. The pinned
  // image (and thus the comparison) comes from config.ROUTER_FIRMWARE_IMAGE.
  router.get("/network/system/firmware-check", async (_req, res, next) => {
    try {
      const check = await getFirmwareCheck();
      res.json(check);
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/network/system/sysupgrade",
    requireRole("owner"),
    async (req, res, next) => {
      try {
        // GATE FIRST — refuse on any non-PRIMARY_ROUTER shape before minting.
        await assertPrimaryRouterPosture();

        const { imagePath, preserveConfig } = req.body ?? {};
        if (typeof imagePath !== "string" || imagePath.trim().length === 0 || imagePath.length > 512) {
          return res.status(400).json({ error: "Provide a non-empty 'imagePath' for the staged sysupgrade image" });
        }
        if (preserveConfig !== undefined && typeof preserveConfig !== "boolean") {
          return res.status(400).json({ error: "'preserveConfig' must be a boolean when provided" });
        }

        const userId = req.user?.id;
        const result = await evaluateNetworkCommand(
          prisma,
          "system.sysupgrade",
          "sysupgrade",
          { imagePath, preserveConfig: preserveConfig ?? true },
          userId,
          "api",
        );

        if ("requiresConfirmation" in result && result.requiresConfirmation) {
          return res.status(202).json({
            status: "confirmation_required",
            operation: "sysupgrade",
            tier: result.tier,
            reason: result.reason,
            confirmationToken: result.confirmationToken,
            expiresIn: 60,
          });
        }

        if ("blocked" in result && result.blocked) {
          return res.status(403).json({ error: result.reason, tier: result.tier, blocked: true });
        }

        // Tier-3 always mints a token for the web UI; this arm is defensive.
        const op = await routerSysupgrade(imagePath, preserveConfig ?? true);
        res.json({ status: "ok", operation: "sysupgrade", operationId: op.operationId });
      } catch (err) {
        if (err instanceof PrimaryRouterRequiredError) return sendPrimaryRouterRequired(res, err);
        next(err);
      }
    },
  );

  router.post(
    "/network/system/factory-reset",
    requireRole("owner"),
    async (req, res, next) => {
      try {
        await assertPrimaryRouterPosture();

        const userId = req.user?.id;
        const result = await evaluateNetworkCommand(
          prisma,
          "system.factory_reset",
          "factory_reset",
          {},
          userId,
          "api",
        );

        if ("requiresConfirmation" in result && result.requiresConfirmation) {
          return res.status(202).json({
            status: "confirmation_required",
            operation: "factory_reset",
            tier: result.tier,
            reason: result.reason,
            confirmationToken: result.confirmationToken,
            expiresIn: 60,
          });
        }

        if ("blocked" in result && result.blocked) {
          return res.status(403).json({ error: result.reason, tier: result.tier, blocked: true });
        }

        const op = await routerFactoryReset();
        res.json({ status: "ok", operation: "factory_reset", operationId: op.operationId });
      } catch (err) {
        if (err instanceof PrimaryRouterRequiredError) return sendPrimaryRouterRequired(res, err);
        next(err);
      }
    },
  );

  // --- droplet-ai RPC access (read-only) ---
  // Read-only scope chips + session, parsed from the live on-box ACL. The
  // rotate/revoke writes are reserved Tier-3 (AI-blocked) with NO dispatcher
  // case — they're honest-gated (disabled) in the UI until a coordinated on-box
  // secret refresh exists (the routing service IS the droplet-ai user, so a
  // desynced rotate self-locks-out the whole Network tab).
  router.get("/network/ai-access", async (_req, res, next) => {
    try {
      const access = await getAiNetworkAccess();
      res.json(access);
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
        case "create_guest_network":
          // Tier-2 confirm for POST /network/wifi/guest. Thread all four pending
          // params (radio default lives on the routing schema, but the route
          // already filled it into the pending record).
          writeResult = await setGuestWifi(
            (params?.radio as string) || "radio3",
            params?.ssid as string,
            params?.password as string,
            (params?.network as string) || "guest"
          );
          break;
        case "set_upnp":
          // Tier-2 confirm for POST /network/upnp.
          writeResult = await setUpnp(params?.enabled as boolean);
          break;
        case "set_ap_band_steering":
          // WARP-1703 — Tier-2 confirm for PUT /network/wifi/band-steering.
          // This is where the 5 GHz SSID rename actually fires, and where the
          // service's honest 422 (AP_BAND_STEERING_UNAVAILABLE) surfaces: the
          // PUT only mints the token, so nothing reaches the APs until here.
          writeResult = await setBandSteering(prisma, params?.enabled as boolean);
          break;
        case "set_ap_wifi_password":
          // WARP-1712 — Tier-2 confirm for PUT /network/wifi/ap when the save
          // carries a new passphrase. Nothing reached the APs on the original
          // PUT (it only minted the token), so this is where the write —
          // and the service's honest 422 (AP_WIRELESS_UNAVAILABLE) — lands.
          // An SSID-only save is Tier 1 and never arrives here.
          // WARP-1761: the intent record is written INSIDE setApWifi, so this
          // separate-request replay records it exactly like the Tier-1 path —
          // there is one seam, not two. `userId` is the confirming human, who
          // is the same principal that minted the token (confirmNetworkCommand
          // enforces the match), so `writtenBy` stays truthful.
          writeResult = await setApWifi(
            prisma,
            {
              ssid: params?.ssid as string | undefined,
              key: params?.key as string | undefined,
            },
            userId,
          );
          break;
        case "set_dhcp_pool":
          // Tier-2 confirm for POST /network/dhcp/pool. The route validated the
          // bounds before minting; the pending record carries the staged values.
          writeResult = await setDhcpPool(
            params?.start as number,
            params?.limit as number,
            params?.leasetime as string,
          );
          break;
        case "set_hostname":
          // Tier-2 confirm for POST /network/system/hostname.
          writeResult = await setHostname(params?.hostname as string);
          break;
        case "add_firewall_rule":
          writeResult = await addFirewallRule({
            name: params?.name as string,
            src: params?.src as string,
            dest: params?.dest as string,
            proto: (params?.proto as string) || "tcp",
            destPort: params?.dest_port as string | undefined,
            srcPort: params?.src_port as string | undefined,
            target: (params?.target as string) || "REJECT",
            enabled: (params?.enabled as string) || "1",
          });
          break;
        case "set_zone_policy":
          writeResult = await setZonePolicy({
            zone: params?.zone as string,
            input: params?.input as string | undefined,
            output: params?.output as string | undefined,
            forward: params?.forward as string | undefined,
          });
          break;
        case "reboot":
          writeResult = await rebootRouter();
          break;
        case "create_interface":
          // KAN-10 Tier-2 confirm for POST /network/interfaces. The pending
          // record carries the staged fields (incl. `force` for a management-
          // interface override); the routing service wraps the write in
          // safe_apply (60s auto-rollback).
          writeResult = await createInterface({
            name: params?.name as string,
            proto: params?.proto as string,
            device: params?.device as string | undefined,
            ipaddr: params?.ipaddr as string | undefined,
            netmask: params?.netmask as string | undefined,
            gateway: params?.gateway as string | undefined,
            force: params?.force as boolean | undefined,
          });
          break;
        case "edit_interface": {
          // KAN-10 Tier-2 confirm for PUT /network/interfaces/:name.
          const { name: ifName, ...editFields } = params ?? {};
          writeResult = await editInterface(ifName as string, editFields);
          break;
        }
        case "restart_network":
          // KAN-10 Tier-3 confirm for POST /network/restart.
          writeResult = await restartNetwork();
          break;
        case "sysupgrade":
          // KAN-8 ⚠️ BRICK RISK. Re-assert the PRIMARY_ROUTER posture at confirm
          // time — a posture change (or a single-box that only LOOKED primary at
          // mint) must not be able to flash through a held token. Throws
          // PrimaryRouterRequiredError → 409 (handled below).
          await assertPrimaryRouterPosture();
          writeResult = await routerSysupgrade(
            params?.imagePath as string,
            (params?.preserveConfig as boolean | undefined) ?? true,
          );
          break;
        case "factory_reset":
          // KAN-8 ⚠️ BRICK RISK. Same confirm-time posture re-check as sysupgrade.
          await assertPrimaryRouterPosture();
          writeResult = await routerFactoryReset();
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
      // KAN-8: a confirm-time posture re-check that fails (the token was minted
      // when the box looked primary, but it isn't now) refuses the brick-risk
      // write with 409 rather than a generic 500.
      if (err instanceof PrimaryRouterRequiredError) {
        return res.status(409).json({ error: err.message, code: err.code, posture: err.posture });
      }
      // Surface structured routing-service refusals (e.g. 409 MANAGEMENT_INTERFACE)
      // directly to the caller instead of letting them collapse into a generic 500.
      if (err instanceof RouterError && err.status === 409) {
        return res.status(409).json({ error: err.toJSON() });
      }
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
