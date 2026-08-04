/**
 * Coverage extender AP routes (WARP-446).
 *
 * Owners + admins can approve / decommission per ADR-004 §3 and the
 * matrix in `__tests__/rbac.test.ts`. Reads (`GET /api/aps`,
 * `GET /api/aps/discovered`, `GET /api/aps/:mac`) are open to every
 * authenticated principal so the LLM agent's `list_ap_devices` tool
 * works under the `service` role.
 *
 * The state machine itself lives in `services/ap-onboard.service.ts`;
 * this file is thin RBAC + validation + dispatch.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole, requireRoleOrMcpService } from "../middleware/auth.js";
import {
  approveAp,
  decommissionAp,
  getApWirelessForMac,
  ApOnboardError,
  DISCOVERED_AP_LRU_CAP,
} from "../services/ap-onboard.service.js";
import { normalizeMac } from "../lib/mac.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("aps-route");

// Body schema for POST /aps/:mac/approve. Mirror of the routing
// service's `ApApproveRequest` shape, just camelCased per orchestrator
// convention.
const approveSchema = z.object({
  ssid: z.string().trim().min(1).max(32),
  // 8 chars = WPA2-PSK minimum; 63 = max passphrase length.
  encryptionKey: z.string().min(8).max(63),
  radio: z.string().trim().min(1).max(16).optional(),
  encryption: z.string().trim().min(3).max(32).optional(),
  network: z.string().trim().min(1).max(15).optional(),
  // Operator-friendly label set at approval time. If omitted, the
  // service derives one from model + last-3-octets.
  displayName: z.string().trim().min(1).max(64).optional(),
});

function macFromParam(req: Request): string {
  try {
    return normalizeMac(req.params.mac);
  } catch {
    // normalizeMac throws DeviceRegistryError — treat any MAC parse
    // failure as a 404 (same as the routing service) so the
    // dashboard can use this endpoint as a "does this MAC exist"
    // probe without distinguishing format errors from real misses.
    throw new ApOnboardError("AP not found", 404, "AP_NOT_FOUND");
  }
}

export function createApsRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── GET /api/aps ─────────────────────────────────────────────
  // Full list of every AP the orchestrator knows about, ordered by
  // most-recently-seen. Open to every auth role — the dashboard's
  // Coverage Extenders panel reads this on every page load.
  router.get("/aps", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const aps = await prisma.apDevice.findMany({
        orderBy: { lastSeen: "desc" },
      });
      // Surface the ADR-005 LRU cap alongside the list so the panel
      // can show "discovery list is full" without a second request.
      // `discoveredCapReached` is derived from the same set the cap
      // controls (AWAITING_APPROVAL + DISCOVERED).
      const discoveredCount = aps.filter(
        (ap) => ap.status === "AWAITING_APPROVAL" || ap.status === "DISCOVERED",
      ).length;
      res.json({
        aps,
        discoveredCap: DISCOVERED_AP_LRU_CAP,
        discoveredCapReached: discoveredCount >= DISCOVERED_AP_LRU_CAP,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/aps/discovered ──────────────────────────────────
  // Filter to actionable rows for the Add Extender wizard. ONLINE
  // and DECOMMISSIONED rows show in the full list (`/api/aps`); this
  // surface only carries rows the operator can act on.
  //
  // Defined BEFORE `/aps/:mac` so the literal "discovered" doesn't
  // get caught as a MAC param.
  router.get("/aps/discovered", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const discovered = await prisma.apDevice.findMany({
        where: {
          status: { in: ["AWAITING_APPROVAL", "DISCOVERED"] },
        },
        orderBy: { lastSeen: "desc" },
      });
      // cap + capReached surface the ADR-005 LRU cap so the dashboard
      // can render "discovery list is full" when a flood of garbage
      // announces is filling the list.
      res.json({
        discovered,
        cap: DISCOVERED_AP_LRU_CAP,
        capReached: discovered.length >= DISCOVERED_AP_LRU_CAP,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/aps/:mac/wireless ───────────────────────────────
  // WARP-1712: live per-AP radio detail behind a Coverage Extenders card —
  // model, firmware, uptime, per-radio band/channel/width, link state and
  // associated clients, read straight off the AP so the card can never show
  // a stale network name.
  //
  // owner/admin (unlike the plain row reads above): the body carries the
  // live Wi-Fi passphrase, same posture as GET /network/wifi/ap and the
  // guest-network PSK read. Registered BEFORE `/aps/:mac` so the literal
  // suffix isn't swallowed by the MAC param.
  router.get(
    "/aps/:mac/wireless",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const mac = macFromParam(req);
        res.json(await getApWirelessForMac(prisma, mac));
      } catch (err) {
        if (err instanceof ApOnboardError) {
          return res.status(err.status).json({ error: err.message, code: err.code });
        }
        next(err);
      }
    },
  );

  // ── GET /api/aps/:mac ────────────────────────────────────────
  router.get("/aps/:mac", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const mac = macFromParam(req);
      const row = await prisma.apDevice.findUnique({ where: { mac } });
      if (!row) {
        return res.status(404).json({ error: "AP not found" });
      }
      res.json(row);
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/aps/:mac/approve ───────────────────────────────
  // WARP-171 / ADR-004 §3: owner + admin only. Approving a new
  // extender changes the household's wireless surface and is the
  // same posture as the existing SSID/PSK writes.
  //
  // Response shape (WARP-446 blocker #2): `{ ap, operationId }`.
  // The operationId is the routing-service's safe_apply op id; the
  // dashboard polls `/api/network/operations/:id` against it so the
  // optimistic-update banner clears the moment apply/rollback lands
  // rather than waiting for the 10s SWR refresh window. operationId
  // is null when the routing layer didn't surface one (mocks, older
  // routing builds, GET fallback) — dashboard treats that as "no op
  // tracking, just refresh".
  //
  // WARP-1461: the approve_ap LLM tool (handler-confirmation / Tier-2)
  // dispatches through this route as the `_service:mcp` principal, which
  // plain requireRole 403s — admit that exact principal (same owner/admin
  // human set). The guard flip only lets the principal REACH the handler;
  // approve_ap's own confirmation flow is unchanged.
  router.post(
    "/aps/:mac/approve",
    requireRoleOrMcpService("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = approveSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "Invalid request",
            details: parsed.error.flatten(),
          });
        }
        const mac = macFromParam(req);
        const actor = {
          username: req.user?.username ?? "dev",
        };
        const { ap, operationId } = await approveAp(prisma, mac, parsed.data, actor);
        res.json({ ap, operationId });
      } catch (err) {
        if (err instanceof ApOnboardError) {
          return res.status(err.status).json({ error: err.message, code: err.code });
        }
        next(err);
      }
    },
  );

  // ── POST /api/aps/:mac/decommission ──────────────────────────
  // Same RBAC posture — removing an extender mid-flight could drop
  // every connected device on that AP, so it stays admin-only. Same
  // `{ ap, operationId }` response shape as approve so the dashboard
  // can poll the apply/rollback state. operationId is null for the
  // idempotent already-DECOMMISSIONED short-circuit (no in-flight
  // routing call to track).
  //
  // WARP-1461: the decommission_ap LLM tool (handler-confirmation /
  // Tier-2) dispatches through this route as the `_service:mcp`
  // principal, which plain requireRole 403s — admit that exact principal
  // (same owner/admin human set). The guard flip only lets the principal
  // REACH the handler; the tool's confirmation flow is unchanged.
  router.post(
    "/aps/:mac/decommission",
    requireRoleOrMcpService("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const mac = macFromParam(req);
        const { ap, operationId } = await decommissionAp(prisma, mac);
        res.json({ ap, operationId });
      } catch (err) {
        if (err instanceof ApOnboardError) {
          return res.status(err.status).json({ error: err.message, code: err.code });
        }
        next(err);
      }
    },
  );

  return router;
}
