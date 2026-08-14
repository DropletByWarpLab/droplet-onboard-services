/**
 * Matter API routes — device discovery, commissioning, control, and SSE events.
 *
 * Commands are evaluated through the three-tier safety framework:
 * - Tier 1: Auto-execute (lights, switches) with rate limiting + bounds checking
 * - Tier 2: Requires user confirmation (locks, covers, extreme temps)
 * - Tier 3: All commands logged to audit trail
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { PrismaClient } from "@prisma/client";
import {
  getCommissionedDevices,
  getDevice,
  sendMatterCommand,
  discoverDevices,
  commissionDevice,
  decommissionDevice,
  reconnectDevice,
  subscribeStateChanges,
  subscribeConnectionChanges,
  isMatterInitialized,
  getMatterCapabilities,
} from "../services/matter.service.js";
import {
  evaluateCommand,
  confirmCommand,
  getAuditLog,
} from "../services/safety-tier.service.js";
import {
  listRooms,
  createRoom,
  updateRoom,
  deleteRoom,
  upsertAlias,
  enrichGrouped,
  RoomValidationError,
} from "../services/rooms.service.js";
import { requireRole, requireRoleOrMcpService } from "../middleware/auth.js";
import {
  actorFromRequest,
  type ActivityActor,
} from "../services/activity.service.js";
import { isUpstreamUnavailable } from "../lib/upstream-unavailable.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("matter-routes");

/**
 * WARP-1010 — actor for matter.service's signed activity rows. Humans map
 * through actorFromRequest as usual; the one service principal these routes
 * admit is `_service:mcp` (requireRoleOrMcpService), i.e. the agent loop's
 * tool dispatch — that surface is the AI, not "system", so the audit page's
 * "what did the AI do" filter keeps catching it.
 */
function matterActor(req: Parameters<typeof actorFromRequest>[0]): ActivityActor {
  const actor = actorFromRequest(req);
  return actor.type === "system" ? { type: "ai", id: null } : actor;
}

/**
 * Empty grouped-devices payload served when the matter-controller sidecar can't
 * answer — either it was never initialized, or it's reachable-but-down at GET
 * time. Same shape the dashboard already handles for the "disconnected" case so
 * the Devices page renders empty groups instead of dead-ending on a 500 during a
 * sidecar outage (mirrors models-summary.service.ts). Never cached — self-heals
 * on the next poll once the sidecar is back.
 */
const DISCONNECTED_DEVICES = {
  lights: [],
  switches: [],
  sensors: [],
  climate: [],
  media: [],
  covers: [],
  locks: [],
  other: [],
  _status: "disconnected",
} as const;

/** Matter node IDs are uint64 — 18446744073709551615 is the ceiling. */
const NODE_ID_MAX = 18446744073709551615n;

/**
 * Validate that a nodeId string is a safe numeric value for BigInt
 * conversion AND inside the uint64 range — 20 digits can exceed the
 * ceiling (e.g. "99999999999999999999"), which would blow up inside
 * the controller as a 500 instead of this validator's 400.
 */
function isValidNodeId(id: string): boolean {
  return /^\d{1,20}$/.test(id) && BigInt(id) <= NODE_ID_MAX;
}

/**
 * WARP-851: shared copy for every "the box can't see the device on the
 * network" failure mode. Used by both the explicit discovery-failure
 * branch and the generic network/BLE branch below.
 */
const NETWORK_DISCOVERY_COPY =
  "Couldn't find the device on the network. Make sure it's powered on, in pairing mode, and on the same Wi-Fi as the Droplet.";

/**
 * WARP-102: translate matter.js commissioning errors into customer-
 * facing strings + an `internalReason` for operator debugging.
 *
 * matter.js raises errors with implementation-specific wording
 * ("Invalid manual code: non-numeric character at position 3", "PASE
 * handshake timed out", etc.) — surfacing those verbatim in the
 * dashboard banner exposes internal details and confuses customers.
 *
 * We pattern-match on the raw message rather than relying on a stable
 * error-code surface because matter.js doesn't export one yet
 * (project-chip/matter.js#1438). Promote to a typed enum once that
 * upstream issue ships.
 *
 * Exported for unit tests (matter.commission-errors.test.ts).
 */
export function translateCommissionError(err: unknown): {
  status: number;
  message: string;
  internalReason: string;
} {
  const raw = err instanceof Error ? err.message : String(err);
  // Order matters — more specific patterns first.
  if (/invalid (manual|qr) code|pairing code|non-numeric|invalid checksum/i.test(raw)) {
    return {
      status: 400,
      message: "That pairing code doesn't look right. Double-check the digits on the device or its packaging and try again.",
      internalReason: raw,
    };
  }
  if (/already.*commissioned|node.*exists/i.test(raw)) {
    return {
      status: 409,
      // Factory-reset procedures are vendor-specific (Aqara holds a
      // button 10s, Hue uses Hue app, Eve uses a paperclip). Don't
      // promise a universal sequence — point the user at the device's
      // own instructions.
      message: "This device is already paired with the Droplet. Open it from the Devices page, or factory-reset it following the device's instructions if you want to re-pair.",
      internalReason: raw,
    };
  }
  // WARP-851: mDNS/BLE discovery found nothing before the waiter
  // expired. matter.js (@matter/protocol ControllerDiscovery) throws
  // CommissionableDeviceDiscoveryFailedError with "No device discovered
  // using identifier {…}! Please check that the relevant device is
  // online." — note "discovered", which the generic /discovery/ pattern
  // below does NOT match, so this used to fall through to the 500 whose
  // copy says to factory-reset the device. On a box that can't hear the
  // device (no BLE, no LAN mDNS — see WARP-850), that advice is harmful:
  // resetting the customer's device can never fix the box's reachability.
  //
  // matter.js 0.17 REWORDED this. ControllerDiscovery is gone; @matter/node's
  // ParallelPaseDiscovery now throws DiscoveryError reading
  // "discovery of <what> failed: No commissionable device was discovered".
  // That string contains neither "no device discovered" nor, on its own, any
  // deliberate marker — it reached this honest copy only because /ble/ below
  // happens to match the substring inside "commissiona-BLE" and /discovery/
  // matches the toString() prefix. Both are accidents of wording that an
  // upstream rename would silently undo, dropping the customer back onto the
  // harmful factory-reset 500. Match the 0.17 detail EXPLICITLY, and keep it
  // ABOVE the timeout branch: the scan is timeout-bounded, so a real failure
  // can carry both, and "we never heard the device at all" is the more
  // specific and more actionable truth.
  if (
    /no device discovered|check that the relevant device is online|no commissionable device was discovered/i.test(
      raw,
    )
  ) {
    return {
      status: 502,
      message: NETWORK_DISCOVERY_COPY,
      internalReason: raw,
    };
  }
  if (/timed? ?out|timeout|deadline/i.test(raw)) {
    return {
      status: 504,
      message: "Couldn't reach the device in time. Put it into pairing mode again, make sure it's within a few feet of the Droplet, and retry.",
      internalReason: raw,
    };
  }
  if (/PASE|SPAKE2|wrong (passcode|secret)/i.test(raw)) {
    return {
      status: 400,
      // PASE / SPAKE2 failures are usually "right code, wrong moment"
      // (the device dropped out of its 60-second pairing window or
      // someone else commissioned it first), not "the code looks
      // wrong" — that's covered by the "invalid pairing code" branch
      // above. Surface the actionable next step rather than a generic
      // "double-check" instruction.
      message: "The device didn't accept the code — it may have left pairing mode. Put it back into pairing mode and try again.",
      internalReason: raw,
    };
  }
  if (/network|wifi|wi-?fi|ble|bluetooth|discovery/i.test(raw)) {
    return {
      status: 502,
      message: NETWORK_DISCOVERY_COPY,
      internalReason: raw,
    };
  }
  return {
    status: 500,
    message: "Commissioning failed. Try again, and if it keeps failing, factory-reset the device and start over.",
    internalReason: raw,
  };
}

/**
 * Map a device category to the safety-rule domain prefix used when minting
 * entityIds (e.g. "lock.12345"). The confirm route deliberately does NOT
 * re-derive this — it binds on the mint-time pending record instead, so a
 * device that degrades to endpoint-0-only mid-confirm-window can't break
 * the WARP-41 echo check.
 *
 * Every category must map to its own distinct domain: TIER_2_DOMAINS and
 * TIER_2_OVERRIDES in safety-rules.ts are keyed on these strings, and an
 * alias (e.g. binary_sensor → sensor) would make rules for the aliased key
 * silently unmatchable.
 */
function categoryToDomain(category: string): string {
  const domainMap: Record<string, string> = {
    light: "light",
    switch: "switch",
    climate: "climate",
    lock: "lock",
    cover: "cover",
    fan: "fan",
    media_player: "media_player",
    sensor: "sensor",
    binary_sensor: "binary_sensor",
    vacuum: "vacuum",
    camera: "camera",
  };
  return domainMap[category] ?? category;
}

/** Map Matter command names to domain/service for safety tier classification. */
function commandToDomainService(
  category: string,
  command: string,
): { domain: string; service: string } {
  const domain = categoryToDomain(category);

  const serviceMap: Record<string, string> = {
    turn_on: "turn_on",
    turn_off: "turn_off",
    toggle: "toggle",
    set_brightness: "turn_on",
    // WARP-1371: the new light writes classify with the other Tier-1 light
    // services; cover/fan/media command names pass through as themselves.
    set_color: "turn_on",
    set_color_temperature: "turn_on",
    set_temperature: "set_temperature",
    // KAN-7: interactive thermostat mode-switch. Maps to climate.set_mode so
    // the safety rules can classify "off" as Tier-2 (confirm) and heat/cool/
    // auto as Tier-1 (direct).
    set_hvac_mode: "set_mode",
    lock: "lock",
    unlock: "unlock",
  };
  const service = serviceMap[command] ?? command;

  return { domain, service };
}

export function createMatterRouter(prisma: PrismaClient): Router {
  const router = Router();

  // --- List commissioned devices (grouped) ---
  router.get("/matter/devices", async (_req, res, next) => {
    try {
      if (!isMatterInitialized()) {
        return res.json(DISCONNECTED_DEVICES);
      }
      // WARP-1396: overlay each device's Droplet-local friendly name + room
      // (the sidecar owns fabric state; this only adds household identity).
      const grouped = await enrichGrouped(prisma, await getCommissionedDevices());
      res.json(grouped);
    } catch (err) {
      if (isUpstreamUnavailable(err)) {
        logger.warn(
          { err },
          "matter-controller unreachable; serving empty device list",
        );
        return res.json(DISCONNECTED_DEVICES);
      }
      next(err);
    }
  });

  // --- SSE stream of device state changes ---
  router.get("/matter/devices/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

    const heartbeat = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 30_000);

    const unsubState = subscribeStateChanges((event) => {
      try {
        res.write(
          `data: ${JSON.stringify({ type: "state_changed", ...event })}\n\n`,
        );
      } catch {
        // Client may have disconnected
      }
    });

    const unsubConn = subscribeConnectionChanges((event) => {
      try {
        res.write(
          `data: ${JSON.stringify({ type: "connection_changed", ...event })}\n\n`,
        );
      } catch {
        // Client may have disconnected
      }
    });

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubState();
      unsubConn();
    });
  });

  // --- Controller capabilities ---
  // WARP-851: read-only surface for the dashboard so the wizard and
  // /devices/add-matter can be honest about which commissioning paths
  // work on this box. Since WARP-850 this proxies the matter-controller
  // sidecar's real state (bleCommissioning=true when its BLE transport
  // registered at process start). Intentionally NOT gated on
  // isMatterInitialized(): the sidecar answers before its controller
  // finishes booting, the wizard needs the answer early, and the
  // service degrades to { bleCommissioning: false } instead of
  // throwing when the sidecar is unreachable.
  router.get("/matter/capabilities", async (_req, res) => {
    res.json(await getMatterCapabilities());
  });

  // --- Discover uncommissioned Matter devices ---
  router.get("/matter/discover", async (req, res, next) => {
    try {
      if (!isMatterInitialized()) {
        return res.status(503).json({ error: "Matter controller not started" });
      }
      const raw = req.query.timeout
        ? parseInt(req.query.timeout as string, 10)
        : 15_000;
      const timeout = Math.min(Math.max(raw || 15_000, 5_000), 60_000);
      const devices = await discoverDevices(timeout);
      res.json({ devices, count: devices.length });
    } catch (err) {
      next(err);
    }
  });

  // --- Commission a new device ---
  // WARP-171: per-route guard. owner + admin + family — household-tier
  // operation. WARP-339: the MCP principal is additionally admitted so
  // the commission_device tool reaches this handler; other service
  // principals (voice-io) stay excluded. Layered gates upstream:
  // routes/llm.ts shows write tools to owner/admin chat users only, and
  // the mcp-server re-checks canCallTool before any dispatch.
  router.post("/matter/commission", requireRoleOrMcpService("owner", "admin", "family"), async (req, res, next) => {
    try {
      if (!isMatterInitialized()) {
        return res.status(503).json({ error: "Matter controller not started" });
      }
      const { pairing_code } = req.body;
      if (!pairing_code || typeof pairing_code !== "string") {
        return res
          .status(400)
          .json({ error: "Missing 'pairing_code' in request body" });
      }
      const result = await commissionDevice(pairing_code, matterActor(req));
      res.json({ status: "commissioned", ...result });
    } catch (err) {
      // WARP-102: matter.js raises errors with implementation-specific
      // wording ("Invalid manual code: non-numeric character at
      // position 3", "PASE handshake timed out", etc.). Surface a
      // customer-friendly message + an `internalReason` field for
      // operator debugging in case support pulls logs from
      // ops-console. Codes we recognize map to fixed phrasing; the
      // rest fall through to a generic timeout/unreachable message
      // so the dashboard banner never leaks raw matter.js internals.
      const friendly = translateCommissionError(err);
      return res.status(friendly.status).json({
        error: friendly.message,
        internalReason: friendly.internalReason,
      });
    }
  });

  // --- Single device details ---
  router.get("/matter/devices/:nodeId", async (req, res, next) => {
    try {
      if (!isMatterInitialized()) {
        return res.status(503).json({ error: "Matter controller not started" });
      }
      if (!isValidNodeId(req.params.nodeId)) {
        return res.status(400).json({ error: "Invalid node ID format" });
      }
      const device = await getDevice(req.params.nodeId);
      if (!device)
        return res.status(404).json({ error: "Device not found" });
      res.json(device);
    } catch (err) {
      next(err);
    }
  });

  // --- Send command (with safety tier evaluation) ---
  // WARP-171: per-route guard. owner + admin + family — same posture
  // as /matter/commission. WARP-339: the MCP principal is admitted so
  // the control_device tool reaches the safety-tier evaluator below
  // instead of 403ing in front of it — `evaluateCommand` still
  // classifies, rate-limits, audits, and mints a 202 for Tier-2
  // (lock-like) commands on every call.
  router.post(
    "/matter/devices/:nodeId/command",
    requireRoleOrMcpService("owner", "admin", "family"),
    async (req, res, next) => {
    try {
      if (!isMatterInitialized()) {
        return res.status(503).json({ error: "Matter controller not started" });
      }

      if (!isValidNodeId(req.params.nodeId)) {
        return res.status(400).json({ error: "Invalid node ID format" });
      }
      const { command, data } = req.body;
      if (!command || typeof command !== "string") {
        return res
          .status(400)
          .json({ error: "Missing 'command' in request body" });
      }

      // Validate HVAC mode before the safety-tier evaluator — unsupported values
      // bypass the Tier-2 gate (only 'off' triggers Tier-2) and crash at the
      // controller with a 500 instead of a 400.
      if (command === "set_hvac_mode") {
        const VALID_HVAC_MODES = ["off", "heat", "cool", "auto"] as const;
        const mode = (data as Record<string, unknown> | undefined)?.mode;
        if (typeof mode !== "string" || !(VALID_HVAC_MODES as readonly string[]).includes(mode)) {
          return res.status(400).json({
            error: `'data.mode' must be one of: ${VALID_HVAC_MODES.join(", ")}`,
          });
        }
      }

      // Resolve device category for safety classification
      const device = await getDevice(req.params.nodeId);
      if (!device)
        return res.status(404).json({ error: "Device not found" });

      const { domain, service } = commandToDomainService(
        device.category,
        command,
      );
      // Use device category as domain prefix so safety rules can classify correctly
      // e.g. "lock.12345" triggers Tier 2, "light.12345" stays Tier 1
      const entityId = `${domain}.${req.params.nodeId}`;
      const userId = (req as any).user?.id;

      const result = await evaluateCommand(
        prisma,
        entityId,
        service,
        data,
        userId,
        // KAN-7: pass the original Matter command so a Tier-2 confirm
        // dispatches it verbatim (set_hvac_mode), not the classification
        // service (set_mode) which the sidecar wouldn't recognise.
        command,
      );

      if ("blocked" in result && result.blocked) {
        return res.status(429).json({
          error: result.reason,
          tier: result.tier,
          blocked: true,
        });
      }

      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          nodeId: req.params.nodeId,
          command,
          // KAN-5: echo the SERVICE the confirm route validates against — it is
          // derived from the same command→{domain,service} mapping used to
          // classify the tier above, so `set_brightness`→`turn_on` etc. round-
          // trips. Without it the client can't satisfy POST /confirm's required
          // `service` echo and the Tier-2 write is silently swallowed.
          service,
          tier: result.tier,
          reason: result.reason,
          confirmationToken: result.confirmationToken,
          expiresIn: 60,
        });
      }

      // Tier 1: Auto-execute
      const cmdResult = await sendMatterCommand(
        req.params.nodeId,
        command,
        matterActor(req),
        data,
      );
      res.json({
        ...cmdResult,
        nodeId: req.params.nodeId,
        command,
        tier: result.tier,
      });
    } catch (err) {
      next(err);
    }
    },
  );

  // --- Confirm a Tier 2 command ---
  // WARP-171: per-route guard. owner + admin + family — confirming a
  // staged command is the same trust tier as issuing one. WARP-339:
  // deliberately NOT relaxed for the MCP principal — the Tier-2 "202
  // only, never executes" invariant holds only if the principal that
  // mints a token cannot also consume it. Human-only, like
  // /network/command/confirm.
  router.post(
    "/matter/devices/:nodeId/confirm",
    requireRole("owner", "admin", "family"),
    async (req, res, next) => {
    try {
      if (!isMatterInitialized()) {
        return res.status(503).json({ error: "Matter controller not started" });
      }

      if (!isValidNodeId(req.params.nodeId)) {
        return res.status(400).json({ error: "Invalid node ID format" });
      }
      const { confirmationToken, service } = req.body;
      if (!confirmationToken) {
        return res.status(400).json({
          error: "Missing 'confirmationToken' in request body",
          code: "TOKEN_MISSING",
        });
      }
      // WARP-41: require echo of the service the caller thinks they're confirming.
      if (!service || typeof service !== "string") {
        return res.status(400).json({
          error: "Missing 'service' — clients must echo the service from the 202 response",
          code: "TOKEN_OPERATION_MISMATCH",
        });
      }

      const userId = (req as any).user?.id;
      // The nodeId in the URL must match the node the token was minted for.
      // The safety-tier service enforces this centrally against the mint-time
      // pending record (WARP-41) — no live getDevice() here, because a device
      // that is offline or mid-reconnect reports a degraded category and a
      // re-derived entityId would 400 the legitimate confirm.
      const result = await confirmCommand(prisma, confirmationToken, userId, {
        service,
        nodeId: req.params.nodeId,
      });

      if (!result.confirmed) {
        return res.status(400).json({ error: result.reason, code: result.code });
      }

      // Use only the command/data from the confirmed token — never from the
      // request body. KAN-7: dispatch the original device command (e.g.
      // set_hvac_mode), which may differ from the classification service
      // (set_mode); for lock/set_temperature the two are identical.
      const cmdResult = await sendMatterCommand(
        req.params.nodeId,
        result.command,
        matterActor(req),
        result.data,
      );
      res.json({
        ...cmdResult,
        nodeId: req.params.nodeId,
        confirmed: true,
      });
    } catch (err) {
      next(err);
    }
    },
  );

  // --- Decommission a device ---
  // WARP-171: per-route guard. owner + admin + family. WARP-339: the
  // MCP principal is admitted (same posture as /matter/commission).
  router.delete(
    "/matter/devices/:nodeId",
    requireRoleOrMcpService("owner", "admin", "family"),
    async (req, res, next) => {
    try {
      if (!isMatterInitialized()) {
        return res.status(503).json({ error: "Matter controller not started" });
      }
      if (!isValidNodeId(req.params.nodeId)) {
        return res.status(400).json({ error: "Invalid node ID format" });
      }
      const removed = await decommissionDevice(
        req.params.nodeId,
        matterActor(req),
      );
      if (!removed) {
        return res.status(404).json({ error: "Device not found" });
      }
      res.json({ status: "decommissioned", nodeId: req.params.nodeId });
    } catch (err) {
      next(err);
    }
    },
  );

  // --- Reconnect an offline device ---
  // WARP-1469: nudge a still-paired but offline device to reconnect now
  // instead of waiting for matter.js's ~10-min WaitingForDeviceDiscovery
  // re-probe. Same guard posture as the other mutating matter routes
  // (owner/admin/family + the MCP service principal for a future
  // reconnect_device tool). Not destructive — the pairing is untouched —
  // but it drives the controller, so it stays out of the read-only tier.
  router.post(
    "/matter/devices/:nodeId/reconnect",
    requireRoleOrMcpService("owner", "admin", "family"),
    async (req, res, next) => {
    try {
      if (!isMatterInitialized()) {
        return res.status(503).json({ error: "Matter controller not started" });
      }
      if (!isValidNodeId(req.params.nodeId)) {
        return res.status(400).json({ error: "Invalid node ID format" });
      }
      const found = await reconnectDevice(req.params.nodeId, matterActor(req));
      if (!found) {
        return res.status(404).json({ error: "Device not found" });
      }
      res.json({ status: "reconnecting", nodeId: req.params.nodeId });
    } catch (err) {
      next(err);
    }
    },
  );

  // --- Audit log ---
  // Reading the command audit log (who operated which device, and when) is a
  // household-admin capability — guard it like the mutating matter routes.
  // Without this, ANY authenticated principal could pass ?userId=<other>/
  // ?entityId=<device> and read every user's lock/unlock history (IDOR).
  //
  // WARP-1461: the get_command_history LLM tool dispatches through this route
  // presenting the `_service:mcp` principal, which plain requireRole 403s —
  // admit that exact principal (same owner/admin human set; chat users
  // without owner/admin never see the tool).
  router.get("/matter/audit", requireRoleOrMcpService("owner", "admin"), async (req, res, next) => {
    try {
      const { entityId, userId, limit, offset } = req.query;
      const effectiveUserId =
        (userId as string | undefined) || (req as any).user?.id;
      const logs = await getAuditLog(prisma, {
        entityId: entityId as string | undefined,
        userId: effectiveUserId,
        limit: limit ? parseInt(limit as string, 10) : undefined,
        offset: offset ? parseInt(offset as string, 10) : undefined,
      });
      res.json({ logs });
    } catch (err) {
      next(err);
    }
  });

  // --- Rooms + device aliases (WARP-1396) ---------------------------------
  // The household map. Reads are any-authenticated (same as /matter/devices);
  // writes are the same household-admin set as the mutating matter routes. All
  // are Droplet-local metadata (Postgres), never Matter fabric state; a rename
  // NEVER writes the Matter nodeLabel — the alias survives re-commissioning.
  function roomError(err: unknown, res: Response, next: NextFunction) {
    if (err instanceof RoomValidationError) {
      return res
        .status(err.status)
        .json({ error: err.code, message: err.message });
    }
    next(err);
  }

  router.get("/matter/rooms", async (_req, res, next) => {
    try {
      res.json({ rooms: await listRooms(prisma) });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/matter/rooms",
    // WARP-1447: the assign_device_room LLM tool auto-creates a missing room
    // on "move the lamp to the den", so admit the MCP service principal like
    // the alias route below (same admit set; human RBAC unchanged — chat
    // users without write roles never see the tool).
    requireRoleOrMcpService("owner", "admin", "family"),
    async (req, res, next) => {
      try {
        const { name, icon } = req.body ?? {};
        res.status(201).json(await createRoom(prisma, { name, icon }));
      } catch (err) {
        roomError(err, res, next);
      }
    },
  );

  router.patch(
    "/matter/rooms/:id",
    requireRole("owner", "admin", "family"),
    async (req, res, next) => {
      try {
        const { name, icon, sortOrder } = req.body ?? {};
        res.json(await updateRoom(prisma, req.params.id, { name, icon, sortOrder }));
      } catch (err) {
        roomError(err, res, next);
      }
    },
  );

  router.delete(
    "/matter/rooms/:id",
    requireRole("owner", "admin", "family"),
    async (req, res, next) => {
      try {
        await deleteRoom(prisma, req.params.id);
        res.status(204).end();
      } catch (err) {
        roomError(err, res, next);
      }
    },
  );

  // Rename and/or (re)assign a room in one call. requireRoleOrMcpService so the
  // assistant can organize devices too (same admit set as commission/command).
  // WARP-1447: registered under PUT (dashboard) AND PATCH (assign_device_room)
  // — the tools-core HttpClient deliberately exposes only get/post/patch/
  // delete, and upsertAlias is a partial update, so PATCH is the honest verb
  // for the tool path. Same guard and handler; behavior is identical.
  const upsertAliasRoute = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const { name, roomId } = req.body ?? {};
      res.json(await upsertAlias(prisma, req.params.nodeId, { name, roomId }));
    } catch (err) {
      roomError(err, res, next);
    }
  };
  router.put(
    "/matter/devices/:nodeId/alias",
    requireRoleOrMcpService("owner", "admin", "family"),
    upsertAliasRoute,
  );
  router.patch(
    "/matter/devices/:nodeId/alias",
    requireRoleOrMcpService("owner", "admin", "family"),
    upsertAliasRoute,
  );

  return router;
}
