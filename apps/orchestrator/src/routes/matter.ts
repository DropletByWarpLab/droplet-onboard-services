/**
 * Matter API routes — device discovery, commissioning, control, and SSE events.
 *
 * Commands are evaluated through the three-tier safety framework:
 * - Tier 1: Auto-execute (lights, switches) with rate limiting + bounds checking
 * - Tier 2: Requires user confirmation (locks, covers, extreme temps)
 * - Tier 3: All commands logged to audit trail
 */

import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import pino from "pino";
import {
  getCommissionedDevices,
  getDevice,
  sendMatterCommand,
  discoverDevices,
  commissionDevice,
  decommissionDevice,
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
import { requireRole } from "../middleware/auth.js";
import { isUpstreamUnavailable } from "../lib/upstream-unavailable.js";

const logger = pino({ name: "matter-routes" });

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
  if (/no device discovered|check that the relevant device is online/i.test(raw)) {
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
    set_temperature: "set_temperature",
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
      const grouped = await getCommissionedDevices();
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
  // operation; service principals (voice-io, mcp) excluded.
  router.post("/matter/commission", requireRole("owner", "admin", "family"), async (req, res, next) => {
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
      const result = await commissionDevice(pairing_code);
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
  // as /matter/commission.
  router.post(
    "/matter/devices/:nodeId/command",
    requireRole("owner", "admin", "family"),
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
  // staged command is the same trust tier as issuing one.
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

      // Use only the command/data from the confirmed token — never from the request body
      const cmdResult = await sendMatterCommand(
        req.params.nodeId,
        result.service,
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
  // WARP-171: per-route guard. owner + admin + family.
  router.delete(
    "/matter/devices/:nodeId",
    requireRole("owner", "admin", "family"),
    async (req, res, next) => {
    try {
      if (!isMatterInitialized()) {
        return res.status(503).json({ error: "Matter controller not started" });
      }
      if (!isValidNodeId(req.params.nodeId)) {
        return res.status(400).json({ error: "Invalid node ID format" });
      }
      const removed = await decommissionDevice(req.params.nodeId);
      if (!removed) {
        return res.status(404).json({ error: "Device not found" });
      }
      res.json({ status: "decommissioned", nodeId: req.params.nodeId });
    } catch (err) {
      next(err);
    }
    },
  );

  // --- Audit log ---
  router.get("/matter/audit", async (req, res, next) => {
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

  return router;
}
