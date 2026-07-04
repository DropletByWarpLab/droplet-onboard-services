/**
 * WARP-268 — egress-audit anomaly ingestion.
 *
 * POST /api/security/egress-anomaly — service-principal push from the
 * host-side egress-audit collector (droplet-egress-audit.service →
 * services/egress-audit/collector.py). Each accepted anomaly lands in the
 * signed activity log (kind "network", severity "warn") via the WARP-456
 * recorder, which makes it visible on /admin/audit with chain integrity —
 * no new table, no dashboard change.
 *
 * The collector dedups client-side (AnomalyGate, 1 h cooldown per flow
 * tuple), so steady-state volume here is near zero; the schema still
 * length-limits every string defensively. 202 with { recorded: false }
 * when the recorder is degraded (recordActivity's fail-soft contract) —
 * the collector must not retry-storm a struggling box; the flow is
 * preserved in its local NDJSON regardless.
 */
import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { actorFromRequest } from "../services/activity.service.js";
import { recordActivity } from "../services/activity.singleton.js";

const anomalySchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(["unlisted_destination", "allowlist_unavailable"]),
  service: z.string().min(1).max(64),
  dst: z.string().min(1).max(64).optional(),
  dstName: z.string().min(1).max(255).optional(),
  port: z.number().int().min(0).max(65535).optional(),
  protocol: z.enum(["tcp", "udp", "icmp", "other"]).optional(),
  firstSeen: z.string().datetime().optional(),
});

export function createEgressAuditRouter(
  record: typeof recordActivity = recordActivity,
): Router {
  const router = Router();

  router.post(
    "/security/egress-anomaly",
    requireRole("service"),
    async (req, res, next) => {
      try {
        const parsed = anomalySchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: "Invalid egress anomaly",
            details: parsed.error.flatten(),
          });
          return;
        }
        const anomaly = parsed.data;
        const destination = anomaly.dstName ?? anomaly.dst ?? "unknown destination";
        const what =
          anomaly.kind === "unlisted_destination"
            ? `Egress anomaly: ${anomaly.service} → ${destination}` +
              (anomaly.port !== undefined ? `:${anomaly.port}` : "")
            : "Egress audit: allowed-egress.yaml unavailable — flows unclassified";
        const row = await record({
          kind: "network",
          severity: "warn",
          sourceIcon: "wifi",
          what,
          sub: anomaly.kind,
          refs: { ...anomaly, source: "egress-audit-collector" },
          actor: actorFromRequest(req),
        });
        res.status(202).json({ recorded: row !== null });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
