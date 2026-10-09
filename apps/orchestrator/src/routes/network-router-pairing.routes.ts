/**
 * Router pairing routes (ADR-071 slice B, WARP-3739).
 *
 *   GET  /network/router/pairing        pairing card state (owner/admin/family)
 *   POST /network/router/pair           claim + persist       (owner/admin)
 *   POST /network/router/pair/persist   retry the persist leg (owner/admin)
 *
 * The POSTs are the owner's confirmed click (the dashboard asks first, ADR-014),
 * not an AI action: `requireRole`, never `requireRoleOrMcpService`. No route here
 * ever returns the password; the service writes one CommandAuditLog row per
 * attempt.
 */
import type { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireRole, requireRoleOrMcpService } from "../middleware/auth.js";
import type { RouterPairingService } from "../services/router-pairing.service.js";

/**
 * The same floor as every other network read (network-status.routes.ts
 * `requireNetworkMember`, WARP-3632). Restated here rather than imported so this
 * module does not pull the whole status-route graph in for one line.
 */
const requireNetworkMember = requireRoleOrMcpService("owner", "admin", "family");

export interface RouterPairingRouteDeps {
  prisma: PrismaClient;
  service: RouterPairingService;
}

function publicBody(r: {
  ok: boolean;
  persisted: boolean;
  host?: string;
  model?: string;
  paired_at?: string;
  error?: string;
  code?: string;
}) {
  const { ok, persisted, host, model, paired_at, error, code } = r;
  return { ok, persisted, host, model, paired_at, error, code };
}

export function registerRouterPairingRoutes(router: Router, deps: RouterPairingRouteDeps): void {
  const { service } = deps;

  router.get("/network/router/pairing", requireNetworkMember, async (_req, res, next) => {
    try {
      res.json(await service.getPairingView());
    } catch (err) {
      next(err);
    }
  });

  router.post("/network/router/pair", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const result = await service.pair(req.user?.id);
      res.status(result.httpStatus).json(publicBody(result));
    } catch (err) {
      next(err);
    }
  });

  router.post("/network/router/pair/persist", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const result = await service.persistPending(req.user?.id);
      res.status(result.httpStatus).json(publicBody(result));
    } catch (err) {
      next(err);
    }
  });
}
