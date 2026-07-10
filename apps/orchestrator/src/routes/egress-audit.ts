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
 * WARP-1062 (audit item E) — two hardening layers in front of the recorder:
 *
 *   1. Exact-principal pinning. `requireRole("service")` admitted ALL six
 *      service principals (voice, mcp, email, sampler, ai-gateway,
 *      egress-audit), so any ONE leaked service token could forge
 *      network-kind anomaly rows into the signed chain. The WARP-268
 *      collector's dedicated bearer maps to `_service:egress-audit` — pin
 *      to exactly that principal id (the requireRoleOrMcpService pattern,
 *      middleware/auth.ts). Every other caller — other service principals
 *      included — gets a 403 plus the WARP-237 "Access denied"
 *      policy-violation row.
 *
 *   2. Per-IP rate limit. The collector dedups client-side (AnomalyGate,
 *      1 h cooldown per flow tuple), so steady-state volume is near zero —
 *      but nothing server-side bounded row-minting by whoever holds the
 *      token. Redis-backed fixed-window limit keyed on proxy-aware
 *      `req.ip` (the WARP-579 / WARP-1138 standard — NEVER the raw
 *      client-controlled X-Forwarded-For header, which would let an
 *      attacker mint a fresh bucket per request by rotating the header).
 *      Fail-open on a Redis outage, same posture as device-clients.ts.
 *
 * The schema still length-limits every string defensively. 202 with
 * { recorded: false } when the recorder is degraded (recordActivity's
 * fail-soft contract) — the collector must not retry-storm a struggling
 * box; the flow is preserved in its local NDJSON regardless.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { actorFromRequest } from "../services/activity.service.js";
import { recordActivity } from "../services/activity.singleton.js";
import { cacheGet, cacheSet } from "../services/cache.service.js";

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

/** The ONLY principal allowed to push anomalies: the WARP-268 collector's
 *  dedicated bearer (SERVICE_TOKEN_EGRESS_AUDIT → middleware/auth.ts
 *  SERVICE_PRINCIPALS). */
const EGRESS_AUDIT_PRINCIPAL_ID = "_service:egress-audit";

// Fixed-window per-IP budget. The collector's client-side AnomalyGate (1 h
// cooldown per flow tuple) makes legitimate steady-state traffic a trickle;
// even a boot-time burst on a busy box stays well under this. The limit is a
// row-minting bound for the signed chain, not an operational tuning knob.
const RATE_LIMIT_WINDOW_SEC = 3600;
const MAX_ANOMALIES_PER_IP_PER_HOUR = 60;

/**
 * WARP-579 / WARP-1138 standard: caller IP for per-IP rate-limit bucket
 * keys. Proxy-aware `req.ip` (`trust proxy` is set in app.ts) — never the
 * leftmost X-Forwarded-For entry, which is client-controlled.
 */
function callerIp(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

/**
 * Redis-backed fixed-window rate limiter — same shape as device-clients.ts.
 * Non-fatal if Redis is unreachable: degrades to "allow" so a cache outage
 * doesn't blind the box to real egress anomalies.
 */
async function rateLimit(bucket: string, limit: number): Promise<boolean> {
  const key = `ratelimit:${bucket}`;
  try {
    const cached = await cacheGet<number>(key);
    const current = typeof cached === "number" ? cached : 0;
    if (current >= limit) return false;
    await cacheSet(key, current + 1, RATE_LIMIT_WINDOW_SEC);
    return true;
  } catch {
    return true;
  }
}

export function createEgressAuditRouter(
  record: typeof recordActivity = recordActivity,
): Router {
  const router = Router();

  // WARP-1062 (audit item E): exact-principal guard. A deny emits the
  // WARP-237 "Access denied" policy-violation row through the injected
  // recorder — fire-and-forget, the 403 must not wait on the append lock.
  const requireEgressAuditPrincipal = (
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (
      req.user?.id === EGRESS_AUDIT_PRINCIPAL_ID &&
      req.user.role === "service"
    ) {
      next();
      return;
    }
    void record({
      kind: "auth",
      severity: "warn",
      sourceIcon: "shield-off",
      what: "Access denied",
      sub: `${req.method} ${req.path}`,
      refs: {
        path: req.path,
        method: req.method,
        role: req.user?.role ?? null,
        principal: req.user?.id ?? null,
        reason: "service-principal-not-permitted",
      },
      actor: actorFromRequest(req),
    });
    res.status(403).json({ error: "Forbidden: egress-audit principal required" });
  };

  router.post(
    "/security/egress-anomaly",
    requireEgressAuditPrincipal,
    async (req, res, next) => {
      try {
        // WARP-1062 (audit item E): bound signed-chain row-minting per caller
        // IP. Plain 429, no audit row — emitting one per over-limit request
        // would hand a flooder a different row-minting primitive.
        if (!(await rateLimit(`egress-anomaly:${callerIp(req)}`, MAX_ANOMALIES_PER_IP_PER_HOUR))) {
          res.status(429).json({ error: "Too many egress anomalies from this IP" });
          return;
        }
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
