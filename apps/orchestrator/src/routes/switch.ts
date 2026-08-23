/**
 * Managed switch API routes — port status, VLANs, PoE, WAN detection.
 *
 * ALL mutation endpoints go through the safety tier system:
 * - Tier 1: Read-only operations (get ports, get VLANs, get PoE)
 * - Tier 2: All writes require user confirmation (port enable/disable,
 *           VLAN create/delete/membership, PoE toggle, camera setup)
 * - Tier 3: Disabling the protected port (the appliance's port) is blocked for AI
 *
 * Proxies requests to the switch service (default :8081) which talks
 * to the hardware via the active driver (pluggable backend; prototype
 * uses the managed switch driver, production may use a custom ASIC).
 */

import { Router, type Response, type NextFunction } from "express";
import { PrismaClient } from "@prisma/client";
import * as switchClient from "../services/switch.client.js";
import {
  fetchSwitchStatus,
  fetchSwitchPorts,
  fetchSwitchVlans,
} from "../services/switch-aggregation.service.js";
import {
  evaluateNetworkCommand,
  confirmNetworkCommand,
} from "../services/network-safety.service.js";
import { requireRole, requireRoleOrMcpService } from "../middleware/auth.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("switch-routes");

/**
 * A switch write can be REFUSED by the service, with a reason worth reading:
 * the ADR-035 §7 PoE guard's 409 ("cutting PoE on port 2 would darken the
 * AP…"), or a 400 from the VLAN membership endpoint ("mode='merge' only
 * accepts untagged member entries — send mode='replace' to write the whole
 * member list"). switch.client surfaces both as an Error carrying `.status` +
 * the service's own message. Relay them with that message instead of
 * collapsing an actionable refusal into a generic 500; everything else flows
 * to the error middleware unchanged.
 */
function surfaceSwitchConflict(
  res: Response,
  err: unknown,
  next: NextFunction,
): void {
  const status = (err as { status?: number } | null | undefined)?.status;
  if (status === 409 || status === 400) {
    res.status(status).json({
      error: err instanceof Error ? err.message : status === 409 ? "Conflict" : "Bad request",
    });
    return;
  }
  next(err);
}

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
  const result = await evaluateNetworkCommand(
    prisma,
    `switch.${operation}`,
    operation,
    params,
    userId,
    source,
  );
  // WARP-1982: carry the operation out with the verdict. evaluateNetworkCommand
  // keeps it only in its server-side pending-confirmation record, so without
  // this every `safetyResponse` call site would have to repeat the literal it
  // just passed in — nine routes, nine chances to drift.
  return { ...result, operation };
}

/** Helper: check if a port is the protected appliance port. */
function isProtectedPort(port: number): boolean {
  return PROTECTED_PORT > 0 && port === PROTECTED_PORT;
}

/**
 * Validate a caller-supplied VLAN membership mode. Returns `undefined` for
 * "not specified" and `null` for "specified, but not a mode" — the caller
 * turns the latter into a 400 rather than silently falling back, because the
 * two modes differ by whether the VLAN's other members survive.
 */
function vlanMembershipMode(
  value: unknown,
): switchClient.VlanMembershipMode | null | undefined {
  if (value === undefined || value === null) return undefined;
  return value === "merge" || value === "replace" ? value : null;
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

/**
 * Helper: return safety tier response (202 for confirmation, 403/429 for blocked).
 *
 * WARP-1982 — the 202 body MUST carry `requiresConfirmation` and `operation`.
 *
 * `NetworkCommandResult` (the shape every dashboard write is typed against)
 * declares both, and `useSwitch`'s two-step dance gates the confirm call on
 * them. Emitting only `status:"confirmation_required"` made that gate false on
 * every switch write: the confirm was skipped, `refresh()` re-read unchanged
 * hardware, and the panel snapped back with NO error — the operator was shown
 * a control that silently did nothing. Cameras hit this exact bug in WARP-861.
 */
function safetyResponse(
  res: any,
  result: {
    requiresConfirmation?: boolean;
    confirmationToken?: string;
    reason?: string;
    tier?: number;
    blocked?: boolean;
    operation?: string;
  }
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
      // The flag the client actually branches on. `status` is a human string;
      // making the machine-readable field implicit in it is what broke this.
      requiresConfirmation: true,
      confirmationToken: result.confirmationToken,
      // Echoed for the client's benefit and for parity with the router's 202.
      // The switch confirm endpoint resolves the operation from the token
      // server-side, so this is descriptive, never load-bearing for execution.
      operation: result.operation,
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

  // §7 GET /api/switch/status — aggregated system-info + poe + provision-config.
  router.get("/switch/status", async (_req, res, next) => {
    try {
      res.json(await fetchSwitchStatus());
    } catch (err) {
      next(err);
    }
  });

  // §7 GET /api/switch/ports — aggregated per-port shape (bare array, per the
  // contract). Joins port_status (link/speed) + vlan_port_stat + membership +
  // poe + provision-config (role/status). Distinct from the raw
  // /switch/ports/:port passthrough below.
  router.get("/switch/ports", async (_req, res, next) => {
    try {
      res.json(await fetchSwitchPorts());
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

  // §7 GET /api/switch/vlans — aggregated {vlan_id,name,isolated,ports[]} (bare
  // array). `isolated` reflects the camera VLAN under the segmented profile.
  router.get("/switch/vlans", async (_req, res, next) => {
    try {
      res.json(await fetchSwitchVlans());
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

      // Execute the confirmed operation.
      //
      // This is the PRIMARY execution path for every Tier-2 switch write (the
      // §7 routes mint a token and the dashboard confirms it here), so it is
      // also where a dishonest answer does the most damage: the switch service
      // returns {status:"planned", dry_run:true} while SWITCH_LIVE_WRITES=0,
      // and this endpoint used to discard that and answer a hard-coded
      // {status:"ok"} — the operator was told a change landed on hardware when
      // nothing had. Keep each client's result and let it speak below.
      const { operation, params } = result;
      const p = (params || {}) as Record<string, unknown>;
      let op: switchClient.SwitchWriteResult | undefined;

      switch (operation) {
        case "switch_port_enable":
          op = await switchClient.enablePort(p.port as number);
          break;
        case "switch_port_disable":
        case "switch_disable_protected_port":
          op = await switchClient.disablePort(p.port as number);
          break;
        case "switch_create_vlan":
          op = await switchClient.createVlan(p.vlan_id as number, (p.name as string) || "");
          break;
        case "switch_delete_vlan":
          op = await switchClient.deleteVlan(p.vlan_id as number);
          break;
        case "switch_set_vlan_membership":
          // Replay the intent the token recorded. A token minted before `mode`
          // existed falls back to `merge`: the safe reading of a membership
          // write, and the only one a one-port list can have meant.
          op = await switchClient.setVlanMembership(
            p.vlan_id as number,
            p.ports as Parameters<typeof switchClient.setVlanMembership>[1],
            vlanMembershipMode(p.mode) ?? "merge",
          );
          break;
        case "switch_poe_enable":
          op = await switchClient.enablePortPoe(p.port as number);
          break;
        case "switch_poe_disable":
          op = await switchClient.disablePortPoe(p.port as number);
          break;
        case "switch_setup_cameras":
          op = await switchClient.setupCameraPorts(
            p.vlan_id as number,
            p.camera_ports as number[],
            p.uplink_ports as number[],
          );
          break;
        case "switch_provision":
          op = await switchClient.provisionSwitch();
          break;
        default:
          return res.status(400).json({ error: `Unknown operation: ${operation}` });
      }

      // The service's own result wins over the optimistic "ok" (so a plan-only
      // write reads status:"planned" + dry_run:true), while `operation` and
      // `confirmed` stay authoritative — they describe the confirmation, not
      // the hardware write.
      res.json({ status: "ok", ...(op ?? {}), operation, confirmed: true });
    } catch (err) {
      next(err);
    }
  });

  // =====================================================================
  // MUTATIONS (Tier 2 — require user confirmation)
  // =====================================================================

  // --- Port enable/disable ---
  // NOTE: the §7-shaped `POST /switch/ports/:port/enable { enabled }` route
  // (which supersedes the legacy no-body enable and also handles disable via
  // the body) is registered in the §7 WRITE ROUTES block below. The legacy
  // `POST /switch/ports/:port/disable` is kept here (the §7 contract folds
  // disable into /enable, but existing callers + the RBAC matrix use /disable).

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
      const op = await switchClient.disablePort(port);
      // Spread the service's result LAST so a plan-only write (dry_run:true,
      // status:"planned") isn't reported to the user as a success that happened.
      res.json({ status: "ok", port, enabled: false, ...op });
    } catch (err) {
      surfaceSwitchConflict(res, err, next);
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
      const op = await switchClient.createVlan(vlan_id, name || "");
      res.json({ status: "ok", vlan_id, ...op });
    } catch (err) {
      surfaceSwitchConflict(res, err, next);
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
      const op = await switchClient.deleteVlan(vlanId);
      res.json({ status: "ok", vlan_id: vlanId, deleted: true, ...op });
    } catch (err) {
      surfaceSwitchConflict(res, err, next);
    }
  });

  // WARP-1462: admit the pinned `_service:mcp` principal so the set_port_vlan
  // LLM tool (which dispatches here via the MCP service bearer) reaches the
  // Tier-2 safety layer instead of 403ing in front of it. Human RBAC is
  // unchanged (owner/admin pass, others 403); the safety tier still classifies,
  // confirms, and audits every call. The phantom-target class WARP-1439 fixed.
  router.post("/switch/vlans/:vlanId/membership", requireRoleOrMcpService("owner", "admin"), async (req, res, next) => {
    try {
      const userId = requireUserId(req.user?.id);
      const vlanId = parseInt(req.params.vlanId);
      const { ports } = req.body;
      if (!Array.isArray(ports)) {
        return res.status(400).json({ error: "ports must be an array" });
      }
      // `mode` decides whether the VLAN's OTHER members survive this write, so
      // it is declared, never inferred from the list. Default `merge` (this is
      // the port-move endpoint the dashboard and the set_port_vlan tool call);
      // `replace` is the whole-member-list write, which the switch service
      // reports back so the caller can see which semantics ran.
      const mode = vlanMembershipMode(req.body?.mode);
      if (mode === null) {
        return res.status(400).json({
          error: 'mode must be "merge" (move these ports into the VLAN) or "replace" (write the VLAN\'s whole member list)',
        });
      }
      const result = await evalSwitchCommand(
        prisma,
        "switch_set_vlan_membership",
        // The mode rides in the audited params so the confirm endpoint replays
        // the intent that was approved instead of re-deciding it.
        { vlan_id: vlanId, ports, mode: mode ?? "merge" },
        userId,
      );
      if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      const op = await switchClient.setVlanMembership(vlanId, ports, mode ?? "merge");
      res.json({ status: "ok", vlan_id: vlanId, ...op });
    } catch (err) {
      surfaceSwitchConflict(res, err, next);
    }
  });

  // --- PoE enable/disable ---

  // WARP-1462: admit `_service:mcp` so the set_port_poe LLM tool reaches the
  // Tier-2 safety layer (phantom-target fix). Human RBAC unchanged.
  router.post("/switch/poe/:port/enable", requireRoleOrMcpService("owner", "admin"), async (req, res, next) => {
    try {
      const userId = requireUserId(req.user?.id);
      const port = parseInt(req.params.port);
      if (isNaN(port) || port < 1 || port > 8) {
        return res.status(400).json({ error: "PoE port must be 1-8" });
      }
      const result = await evalSwitchCommand(prisma, "switch_poe_enable", { port }, userId);
      if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      const op = await switchClient.enablePortPoe(port);
      res.json({ status: "ok", port, poe_enabled: true, ...op });
    } catch (err) {
      surfaceSwitchConflict(res, err, next);
    }
  });

  // WARP-1462: admit `_service:mcp` so the set_port_poe LLM tool reaches the
  // Tier-2 safety layer (phantom-target fix). Human RBAC unchanged.
  router.post("/switch/poe/:port/disable", requireRoleOrMcpService("owner", "admin"), async (req, res, next) => {
    try {
      const userId = requireUserId(req.user?.id);
      const port = parseInt(req.params.port);
      if (isNaN(port) || port < 1 || port > 8) {
        return res.status(400).json({ error: "PoE port must be 1-8" });
      }
      const result = await evalSwitchCommand(prisma, "switch_poe_disable", { port }, userId);
      if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      const op = await switchClient.disablePortPoe(port);
      // dry_run:true (SWITCH_LIVE_WRITES=0) surfaces as status:"planned" so the
      // dashboard stops reporting a PoE cut that never happened.
      res.json({ status: "ok", port, poe_enabled: false, ...op });
    } catch (err) {
      // A 409 here is the guard refusing to darken a device with no remote
      // recovery — relay its message verbatim, don't bury it as a 500.
      surfaceSwitchConflict(res, err, next);
    }
  });

  // --- WAN Detection ---

  // WARP-1462: admit `_service:mcp` so the detect_wan_port LLM tool reaches the
  // safety layer (phantom-target fix). Human RBAC unchanged.
  // WARP-2125: that layer is Tier 1 now, not Tier 2 — detection is a pure read
  // (returns {wan_port, confidence, reason}, writes nothing), so it executes
  // directly under the same RBAC + audit instead of minting a confirmation
  // token the write dispatcher could never redeem.
  router.post("/switch/wan/detect", requireRoleOrMcpService("owner", "admin"), async (req, res, next) => {
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

  // WARP-1462: admit `_service:mcp` so the setup_camera_ports LLM tool reaches
  // the Tier-2 safety layer (phantom-target fix). Human RBAC unchanged.
  router.post("/switch/setup/cameras", requireRoleOrMcpService("owner", "admin"), async (req, res, next) => {
    try {
      const userId = requireUserId(req.user?.id);
      const { vlan_id, camera_ports, uplink_ports } = req.body || {};
      // Resolve the defaults once so the values the safety tier audits are the
      // exact values executed below (WARP-559 review follow-up). Previously the
      // audit saw `vlan_id || 100` etc. while `setupCameraPorts` was called with
      // the raw, possibly-undefined body fields — auditing one thing, doing
      // another.
      const resolvedVlanId = vlan_id || 100;
      const resolvedCameraPorts = camera_ports || [1, 2, 3, 4, 5, 6, 7, 8];
      const resolvedUplinkPorts = uplink_ports || [9, 10];
      const result = await evalSwitchCommand(
        prisma, "switch_setup_cameras",
        { vlan_id: resolvedVlanId, camera_ports: resolvedCameraPorts, uplink_ports: resolvedUplinkPorts },
        userId
      );
      if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      const setupResult = await switchClient.setupCameraPorts(resolvedVlanId, resolvedCameraPorts, resolvedUplinkPorts);
      res.json(setupResult);
    } catch (err) {
      next(err);
    }
  });

  // =====================================================================
  // §7 WRITE ROUTES (ADDON §7) — the shapes the dashboard panel calls.
  //
  // Each translates the §7 request into the existing Tier-2 op + evaluates
  // it through the safety tier (Tier-2 → 202 + confirmation token; the
  // /switch/command/confirm endpoint executes on confirm). The actual
  // hardware write is dry-run while the driver is plan_only=True (the
  // deferred item-11 supervised live-write flip): confirm → the driver logs
  // the plan and the read-back is unchanged. RBAC + Activity reuse the
  // existing path (requireRole + evalSwitchCommand's audit/activity write).
  // =====================================================================

  // POST /api/switch/ports/:port/vlan { vlan_id } — move a port's access VLAN.
  // Translates to set-vlan-membership(vlan_id, [{port, untagged}]). The
  // protected/uplink port is never moved off its VLAN → Tier-3 block branch.
  router.post("/switch/ports/:port/vlan", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const userId = requireUserId(req.user?.id);
      const port = parseInt(req.params.port);
      if (isNaN(port) || port < 1 || port > 10) {
        return res.status(400).json({ error: "Invalid port number (1-10)" });
      }
      const { vlan_id } = req.body || {};
      if (typeof vlan_id !== "number" || vlan_id < 1 || vlan_id > 4094) {
        return res.status(400).json({ error: "vlan_id must be a number 1-4094" });
      }
      // Moving the protected port off its VLAN would sever the appliance —
      // route it through the Tier-3 protected-port op (blocked for AI).
      if (isProtectedPort(port)) {
        const result = await evalSwitchCommand(prisma, "switch_disable_protected_port", { port, vlan_id }, userId);
        if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
        // (Unreachable for Tier-3 web UI, which always needs confirmation; the
        // confirm endpoint owns execution.)
        return res.json({ status: "ok", port, vlan_id });
      }
      const ports = [{ port, tagged: false, member: true }];
      // MERGE, always: this route moves ONE port's access VLAN. Sent as a
      // whole-member-list write it would drop every other member of the target
      // VLAN — on the flat-LAN default that is the uplink, the AP and the
      // appliance, i.e. one click strands the rack (audit 2026-08-06).
      const result = await evalSwitchCommand(
        prisma, "switch_set_vlan_membership", { vlan_id, ports, mode: "merge" }, userId
      );
      if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      const op = await switchClient.setVlanMembership(vlan_id, ports, "merge");
      // Spread the service's result LAST: a plan-only write (dry_run:true,
      // status:"planned") must not be reported as a move that happened.
      res.json({ status: "ok", port, vlan_id, ...op });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/switch/ports/:port/poe { enabled } — toggle PoE on a copper port.
  router.post("/switch/ports/:port/poe", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const userId = requireUserId(req.user?.id);
      const port = parseInt(req.params.port);
      if (isNaN(port) || port < 1 || port > 8) {
        return res.status(400).json({ error: "PoE port must be 1-8 (copper only)" });
      }
      const { enabled } = req.body || {};
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "enabled must be a boolean" });
      }
      const operation = enabled ? "switch_poe_enable" : "switch_poe_disable";
      const result = await evalSwitchCommand(prisma, operation, { port }, userId);
      if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      const op = enabled
        ? await switchClient.enablePortPoe(port)
        : await switchClient.disablePortPoe(port);
      // …LAST, so a plan-only write reports planned/dry_run instead of a PoE
      // change the operator can watch NOT happen on the device.
      res.json({ status: "ok", port, poe_enabled: enabled, ...op });
    } catch (err) {
      // A 409 here is the §7 guard refusing to darken a device that has no
      // remote recovery — relay its message, don't bury it as a 500.
      surfaceSwitchConflict(res, err, next);
    }
  });

  // POST /api/switch/ports/:port/enable { enabled } — admin enable/disable.
  // Disabling the protected port is Tier-3 (blocked for AI) — keep that branch.
  router.post("/switch/ports/:port/enable", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const userId = requireUserId(req.user?.id);
      const port = parseInt(req.params.port);
      if (isNaN(port) || port < 1 || port > 10) {
        return res.status(400).json({ error: "Invalid port number" });
      }
      // §7: a body { enabled } selects enable vs disable. Absent body defaults
      // to enable (backward-compatible with the legacy no-body /enable route
      // exercised by rbac.test.ts).
      const enabled = req.body && typeof req.body.enabled === "boolean" ? req.body.enabled : true;

      if (!enabled && isProtectedPort(port)) {
        const result = await evalSwitchCommand(prisma, "switch_disable_protected_port", { port }, userId);
        if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
        const protectedOp = await switchClient.disablePort(port);
        return res.json({ status: "ok", port, enabled: false, ...protectedOp });
      }
      const operation = enabled ? "switch_port_enable" : "switch_port_disable";
      const result = await evalSwitchCommand(prisma, operation, { port }, userId);
      if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      const op = enabled
        ? await switchClient.enablePort(port)
        : await switchClient.disablePort(port);
      // …LAST: planned/dry_run must reach the panel, not a fabricated "ok".
      res.json({ status: "ok", port, enabled, ...op });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/switch/provision — re-apply the managed switch layout.
  // New `switch_provision` Tier-2 op; the confirm endpoint proxies the service
  // /provision via provisionSwitch().
  router.post("/switch/provision", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const userId = requireUserId(req.user?.id);
      const result = await evalSwitchCommand(prisma, "switch_provision", {}, userId);
      if (!("allowed" in result && result.allowed)) return safetyResponse(res, result);
      const provisionResult = await switchClient.provisionSwitch();
      res.json(provisionResult);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
