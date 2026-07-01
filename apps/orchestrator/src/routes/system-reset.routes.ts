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
 *   GET  /api/system/reset       — owner-only. Returns a MASKED hint of the
 *                                  target name plus the latest reset job for the
 *                                  progress poll. The verbatim hostname is never
 *                                  returned here (2026-06-09 sweep): handing the
 *                                  modal the exact string to copy/paste removed
 *                                  the per-device type-to-confirm friction. The
 *                                  owner reads the name from Settings → Device
 *                                  information.
 *
 * owner-only per ADR-004 §3 (destructive system actions like the service
 * restart routes and POST /api/network/system/reboot are owner-only);
 * factory-reset is the most destructive of these so it carries the same — the
 * single strictest — guard. The guard is asserted in the RBAC MATRIX
 * (__tests__/rbac.test.ts).
 */

import { Router } from "express";
import os from "node:os";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import {
  requestFactoryReset,
  getResetStatus,
  ResetError,
  type ResetErrorCode,
} from "../services/reset.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("system-reset-route");

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

/**
 * Masked hint of the confirm target (first + last char survive as an
 * orientation cue; bullet count is clamped so the mask doesn't encode the
 * exact length). The owner types the real name from Settings → Device
 * information — the API deliberately never hands the modal a copy/paste-able
 * confirm value.
 */
function maskedTargetHint(name: string): string {
  const n = (name ?? "").trim();
  if (n.length <= 2) return "••";
  const bullets = Math.min(Math.max(n.length - 2, 3), 8);
  return `${n[0]}${"•".repeat(bullets)}${n[n.length - 1]}`;
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

  // GET status — owner-only (the whole Danger Zone surface is owner-gated).
  // Only a MASKED hint of the target name leaves the API; the job row's
  // targetName is masked with the same rule so the history poll can't be
  // used as a side door to the verbatim confirm value.
  router.get("/system/reset", requireRole("owner"), async (_req, res, next) => {
    try {
      const job = await getResetStatus(prisma);
      res.json({
        targetHint: maskedTargetHint(canonicalTargetName()),
        job: job ? { ...job, targetName: maskedTargetHint(job.targetName) } : null,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST reset — owner-only, server-side friction, dispatched via host executor.
  router.post("/system/reset", requireRole("owner"), async (req, res, next) => {
    const confirm = typeof req.body?.confirm === "string" ? req.body.confirm : "";
    if (!confirm) {
      return res.status(400).json({
        error: "Type your device's name to confirm.",
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
        targetName: maskedTargetHint(job.targetName),
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
