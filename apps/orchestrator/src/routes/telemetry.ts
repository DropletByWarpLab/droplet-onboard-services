import { Router } from "express";
import { requireRole } from "../middleware/auth.js";
import { getBoxTelemetry } from "../services/box-telemetry/index.js";
import { inertBoxTelemetry } from "../services/box-telemetry/sender.js";

/**
 * WARP-3504 (ADR-068) — "what this Droplet sends to Warp", for the owner
 * (Settings -> What this Droplet sends). Read-only, owner/admin, mounted
 * after authMiddleware.
 *
 *   GET /api/telemetry/last — the sender's state, the last payload of each
 *   kind that the portal accepted (the exact JSON that was sent) with its
 *   timestamp, what is waiting to be sent, and the plain-language schema
 *   descriptions.
 *
 * Owner + admin only, reads included: the payloads carry release and service
 * detail that is operator material, same posture as /api/updates. Before boot
 * wiring (tests, dev tools) it answers as `unconfigured`.
 */
export function createTelemetryRouter(): Router {
  const router = Router();
  router.get("/telemetry/last", requireRole("owner", "admin"), (_req, res) => {
    res.json((getBoxTelemetry() ?? inertBoxTelemetry("unconfigured")).snapshot());
  });
  return router;
}
