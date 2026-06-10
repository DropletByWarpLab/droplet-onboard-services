/**
 * system-reset.routes — Settings Danger Zone factory-reset endpoint (WARP-825).
 *
 *   POST /api/system/reset       — owner-only. Body: { confirm: string }. The
 *                                  `confirm` value is the device name the owner
 *                                  typed into the type-to-confirm field; it is
 *                                  validated SERVER-side against the canonical
 *                                  appliance hostname (the client gate is not the
 *                                  authority). On a match: writes the audit row,
 *                                  guards double-fire, and dispatches the reset
 *                                  through the device-bridge host executor. Never
 *                                  shells factory-reset.sh from the web tier.
 *   GET  /api/system/reset       — owner-only. Returns the canonical target name
 *                                  (so the UI shows exactly what to type) plus the
 *                                  latest reset job for the progress poll.
 *
 * owner-only per ADR-004 §3 (destructive system actions like the service
 * restart routes and POST /api/network/system/reboot are owner-only);
 * factory-reset is the most destructive of these so it carries the same — the
 * single strictest — guard. The guard is asserted in the RBAC MATRIX
 * (__tests__/rbac.test.ts).
 */

import { Router } from "express";
import os from "node:os";
import pino from "pino";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import {
  requestFactoryReset,
  getResetStatus,
  ResetError,
  type ResetErrorCode,
} from "../services/reset.service.js";

const logger = pino({ name: "system-reset-route" });

/**
 * The canonical name the reset targets + that the owner must type to confirm.
 * Derived from the appliance's own hostname (the same source
 * device-registration.service.ts uses to seed the Device row, and that the
 * Settings → Device Information row displays). Server-derived so the client can
 * never dictate the value the friction check compares against.
 */
function canonicalTargetName(): string {
  return (os.hostname() || "droplet").trim();
}

/** Map a ResetError to an HTTP status. */
function statusForResetError(code: ResetErrorCode): number {
  switch (code) {
    case "CONFIRM_MISMATCH":
      return 400;
    case "RESET_ALREADY_IN_PROGRESS":
      return 409;
    case "SERIALIZATION_CONFLICT":
      return 503;
    case "BRIDGE_AUTH_UNCONFIGURED":
      return 503;
    case "BRIDGE_UNREACHABLE":
      return 503;
    case "BRIDGE_REFUSED":
      return 502;
    default:
      return 500;
  }
}

export function createSystemResetRouter(prisma: PrismaClient): Router {
  const router = Router();

  // GET status — owner-only (the target name is low-sensitivity, but the whole
  // Danger Zone surface is owner-gated, so keep the read consistent).
  router.get("/system/reset", requireRole("owner"), async (_req, res, next) => {
    try {
      const job = await getResetStatus(prisma);
      res.json({ targetName: canonicalTargetName(), job });
    } catch (err) {
      next(err);
    }
  });

  // POST reset — owner-only, server-side friction, dispatched via host executor.
  router.post("/system/reset", requireRole("owner"), async (req, res, next) => {
    const confirm = typeof req.body?.confirm === "string" ? req.body.confirm : "";
    if (!confirm) {
      return res.status(400).json({
        error: 'Type "factory reset" to confirm.',
        code: "CONFIRM_MISMATCH",
      });
    }
    try {
      const job = await requestFactoryReset(prisma, {
        userId: req.user?.id,
        typedConfirm: confirm,
        targetName: canonicalTargetName(),
      });
      // 202 Accepted — the wipe has been dispatched and runs detached; the
      // orchestrator will be torn down shortly. `dispatched` is terminal-success.
      return res.status(202).json({
        status: job.status,
        id: job.id,
        targetName: job.targetName,
      });
    } catch (err) {
      if (err instanceof ResetError) {
        logger.warn({ code: err.code }, "factory reset rejected");
        return res.status(statusForResetError(err.code)).json({
          error: err.message,
          code: err.code,
        });
      }
      return next(err);
    }
  });

  return router;
}
