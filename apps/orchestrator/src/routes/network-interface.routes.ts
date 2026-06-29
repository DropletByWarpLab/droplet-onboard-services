/**
 * Interface Add / Edit / Restart write routes (KAN-10).
 *
 * The Interfaces table was read-only (PR #669). These add the guarded write
 * path. Editing an interface is high blast radius — a wrong proto/address/zone
 * can cut the dashboard's own connectivity — so every write here:
 *   - is owner-only (restart) / owner+admin (add/edit), no MCP principal:
 *     rewriting /etc/config/network is a deliberate human action, never AI-driven;
 *   - flows through the network-safety evaluator and answers 202
 *     `confirmation_required` (Tier 2 add/edit, Tier 3 restart) with a
 *     blast-radius reason — it NEVER applies on the first POST/PUT;
 *   - is dispatched (after /network/command/confirm) onto the routing service,
 *     which wraps the actual UCI write in safe_apply (60s auto-rollback) and
 *     refuses a management-interface write unless `force` is set.
 */

import type { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  createInterface,
  editInterface,
} from "../services/network.service.js";
import { evaluateNetworkCommand } from "../services/network-safety.service.js";
import { requireRole } from "../middleware/auth.js";
import type { InterfaceWriteFields } from "../services/openwrt.client.js";

export interface InterfaceRouteDeps {
  prisma: PrismaClient;
}

// UCI interface section name: lowercase letters, digits, underscores — mirrors
// the routing CreateInterfaceRequest grammar so a bad name is rejected before a
// token is minted.
const INTERFACE_NAME_RE = /^[a-z0-9_]{1,15}$/;
const INTERFACE_PROTOS = new Set(["static", "dhcp", "dhcpv6", "none", "pppoe"]);
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$/;

/** Validate the optional address fields shared by create + edit. Returns an
 *  error message, or null if every supplied field is well-formed. */
function validateAddressFields(body: Record<string, unknown>): string | null {
  for (const f of ["ipaddr", "netmask", "gateway"] as const) {
    const v = body[f];
    if (v !== undefined && (typeof v !== "string" || !IPV4_RE.test(v))) {
      return `'${f}' must be a valid IPv4 address`;
    }
  }
  if (
    body.device !== undefined &&
    (typeof body.device !== "string" || body.device.length === 0 || body.device.length > 31)
  ) {
    return "'device' must be a non-empty device name";
  }
  return null;
}

/** Pull only the editable fields off the request body. */
function pickFields(body: Record<string, unknown>): InterfaceWriteFields {
  const fields: InterfaceWriteFields = {};
  if (typeof body.proto === "string") fields.proto = body.proto;
  if (typeof body.device === "string") fields.device = body.device;
  if (typeof body.ipaddr === "string") fields.ipaddr = body.ipaddr;
  if (typeof body.netmask === "string") fields.netmask = body.netmask;
  if (typeof body.gateway === "string") fields.gateway = body.gateway;
  if (typeof body.force === "boolean") fields.force = body.force;
  return fields;
}

export function registerInterfaceRoutes(router: Router, deps: InterfaceRouteDeps): void {
  const { prisma } = deps;

  // Add an interface — owner/admin, Tier 2. No MCP principal: writing
  // /etc/config/network is a deliberate human action, like zone-policy/upnp.
  router.post("/network/interfaces", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { name, proto } = body;
      if (typeof name !== "string" || !INTERFACE_NAME_RE.test(name)) {
        return res.status(400).json({
          error: "Provide a 'name' — lowercase letters, digits and underscores, max 15 chars",
        });
      }
      if (typeof proto !== "string" || !INTERFACE_PROTOS.has(proto)) {
        return res.status(400).json({
          error: `Provide a 'proto' — one of ${[...INTERFACE_PROTOS].join(", ")}`,
        });
      }
      const addrError = validateAddressFields(body);
      if (addrError) return res.status(400).json({ error: addrError });

      const fields = pickFields(body);
      const params = { name, proto, ...fields };

      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma,
        `network.interface.${name}`,
        "create_interface",
        params,
        userId,
      );

      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          operation: "create_interface",
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

      // Tier 1 is never returned for create_interface, but guard the arm so a
      // future tier downgrade can't silently no-op the write.
      const op = await createInterface({ name, proto, ...fields });
      res.json({ status: "ok", name, tier: result.tier, operationId: op.operationId });
    } catch (err) {
      next(err);
    }
  });

  // Edit an interface — owner/admin, Tier 2.
  router.put("/network/interfaces/:name", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const { name } = req.params;
      if (typeof name !== "string" || !INTERFACE_NAME_RE.test(name)) {
        return res.status(400).json({ error: "Invalid interface name" });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.proto !== undefined && (typeof body.proto !== "string" || !INTERFACE_PROTOS.has(body.proto))) {
        return res.status(400).json({
          error: `'proto' must be one of ${[...INTERFACE_PROTOS].join(", ")}`,
        });
      }
      const addrError = validateAddressFields(body);
      if (addrError) return res.status(400).json({ error: addrError });

      const fields = pickFields(body);
      // An edit must change at least one config field (force is a flag, not a change).
      const hasChange = ["proto", "device", "ipaddr", "netmask", "gateway"].some(
        (k) => fields[k as keyof InterfaceWriteFields] !== undefined,
      );
      if (!hasChange) {
        return res.status(400).json({ error: "Provide at least one field to change" });
      }

      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma,
        `network.interface.${name}`,
        "edit_interface",
        { name, ...fields },
        userId,
      );

      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          operation: "edit_interface",
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

      const op = await editInterface(name, fields);
      res.json({ status: "ok", name, tier: result.tier, operationId: op.operationId });
    } catch (err) {
      next(err);
    }
  });

  // Restart networking — owner ONLY, Tier 3. A blunt instrument that briefly
  // drops every interface (this dashboard included), so it carves out the same
  // owner-only tier as /network/system/reboot. NO MCP principal: never
  // AI-triggerable.
  router.post("/network/restart", requireRole("owner"), async (req, res, next) => {
    try {
      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma,
        "network.restart",
        "restart_network",
        {},
        userId,
        "api",
      );

      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          operation: "restart_network",
          tier: result.tier,
          reason: result.reason,
          confirmationToken: result.confirmationToken,
          expiresIn: 60,
        });
      }
      if ("blocked" in result && result.blocked) {
        return res.status(403).json({ error: result.reason, tier: result.tier, blocked: true });
      }

      // restart_network is Tier 3 — this direct-apply arm is unreachable from the
      // web UI (which always gets a 202), kept only as a defensive fallthrough.
      const { restartNetwork } = await import("../services/network.service.js");
      const op = await restartNetwork();
      res.json({ status: "ok", action: "network_restart", tier: result.tier, operationId: op.operationId });
    } catch (err) {
      next(err);
    }
  });
}
