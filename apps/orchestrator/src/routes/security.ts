/**
 * WARP-2977 (ADR-059 §3.1) — the Security command center's read API.
 *
 *   GET /api/security/events   the fused feed, newest first
 *   GET /api/security/health   what the feed is listening to, and whether
 *                              each source is reporting
 *
 * Gating, in order:
 *   1. the box-wide `security` toggle and the per-person `security` grant at
 *      `view` — both mounted by `mountModuleGates` off the registry prefix
 *      `/api/security` (the module is in FEATURE_GATED_MODULES);
 *   2. `requireRole` — household tiers only; guests never see presence data;
 *   3. per ROW: camera rows follow CameraAccessGrant, absent rather than
 *      redacted (DS-005); mirrored threats follow the owner/admin gate of the
 *      ActivityRows they point at.
 *
 * P2 is a feed, not an alarm system — nothing here notifies. The `act` and
 * `manage` levels arrive with the first routes that need them (mode, zones:
 * P2b), each pinned by a test when it does. Those live in their own routers
 * (routes/security-zones.ts, routes/security-site.ts), mounted beside this
 * one; who-sees-what for all three comes from services/security-access.ts.
 *
 * WARP-2977 P2b — areas on the feed (spec §6.1):
 *   · `?zone=<uuid>` narrows to one area. The area's clause is ANDed AFTER
 *     the camera clause; the DS-005 visibility clause stays `AND[0]`. An
 *     area that is missing, removed, hidden from the viewer or has no
 *     visible link answers an empty page WITHOUT a query — the P2a
 *     ungranted-camera convention, never a 403/404 that confirms it exists.
 *   · every row carries `zones: [{id, name}]`, resolved at read time from the
 *     viewer's VISIBLE links of VISIBLE areas — a row never names an area the
 *     viewer cannot see.
 *   · `mode_changed` rows (the site mode's history) are a feed kind.
 *
 * WARP-2978 (ADR-059 P3 §7 routes 1–2):
 *   · every row carries `incident: {id} | null` — the incident the engine
 *     grouped it into (one IN query on SecurityEventTriage). An event the
 *     viewer can see implies its incident is visible to them (the incident's
 *     cameras include that event's camera; site scopes follow the same
 *     threat rule as the row), so no second visibility check is needed;
 *   · the header gains the `incidents` row (everyone) and the `alerts` row
 *     (owner/admin only — it names who is told), after `site_mode`.
 */
import { Router, type Request, type Response } from "express";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import {
  buildSecurityHealth,
  feedVisibilityWhere,
  listSecurityEvents,
  parseFeedCursor,
  securityIngestHealthState,
} from "../services/security-events.service.js";
import { securityStatusSnapshot } from "../services/camera.service.js";
import { mayReadThreats, securityViewerScope, type SecurityRouteDeps } from "../services/security-access.js";
import { securitySiteModeHealth } from "../services/security-mode.service.js";
import { securityIncidentsHealth } from "../services/security-incidents.service.js";
import { securityAlertsHealth } from "../services/security-alerts.service.js";
import { securityPatternsHealth } from "../services/security-baselines.service.js";
import { loadActiveLinks, viewerAreas, zoneChipsFor, zoneFilterFor } from "../services/security-zones.service.js";
import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("security-routes");

/** Same household floor as the camera surface (`CAMERA_VIEW_ROLES`). */
const SECURITY_VIEW_ROLES = ["owner", "admin", "family"] as const;

const FEED_KINDS = [
  "detection",
  "detection_low",
  "camera_offline",
  "camera_online",
  "source_offline",
  "source_online",
  "threat",
  "mode_changed",
] as const;

const feedQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(40).optional(),
    kind: z
      .string()
      .max(200)
      .optional()
      .transform((v) => (v ? v.split(",").filter(Boolean) : undefined))
      .pipe(z.array(z.enum(FEED_KINDS)).min(1).max(FEED_KINDS.length).optional()),
    camera: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/)
      .optional(),
    includeLow: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => v === "true"),
    /** WARP-2977 P2b — one area (SecurityZone.id). */
    zone: z.string().uuid().optional(),
  })
  .strict();

/**
 * WARP-2978 — the incident each event on a page belongs to, keyed by event id.
 * Only `grouped` triage rows point at an incident.
 */
async function incidentOfEvents(
  prisma: Pick<PrismaClient, "securityEventTriage">,
  eventIds: readonly string[],
): Promise<Map<string, string>> {
  if (eventIds.length === 0) return new Map();
  const rows = await prisma.securityEventTriage.findMany({
    where: { eventId: { in: eventIds.map((id) => BigInt(id)) }, outcome: "grouped" },
    select: { eventId: true, incidentId: true },
  });
  return new Map(rows.filter((r) => r.incidentId !== null).map((r) => [r.eventId.toString(), r.incidentId!]));
}

/**
 * `deps` (WARP-2977 P2b) is the shared Security router deps shape: the feed
 * reads `deps.resolve` for the viewer scope, the health header `deps.now`.
 */
export function createSecurityRouter(prisma: PrismaClient, deps: SecurityRouteDeps = {}): Router {
  const router = Router();

  router.get("/security/events", requireRole(...SECURITY_VIEW_ROLES), async (req: Request, res: Response) => {
    const parsed = feedQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "VALIDATION_ERROR", issues: parsed.error.issues });
      return;
    }
    const q = parsed.data;
    const cursor = q.cursor ? parseFeedCursor(q.cursor) : undefined;
    if (q.cursor && !cursor) {
      res.status(400).json({ error: "VALIDATION_ERROR", issues: [{ path: ["cursor"], message: "bad cursor" }] });
      return;
    }
    try {
      const scope = await securityViewerScope(prisma, req, deps.resolve);
      const visible = scope.visibleCameras;
      // A camera outside the grant answers exactly like a camera with no
      // events — an empty page, never a 403 that confirms it exists.
      if (q.camera && visible !== "all" && !visible.has(q.camera)) {
        res.json({ events: [], nextCursor: null });
        return;
      }
      const links = await loadActiveLinks(prisma);
      const extraWhere: Prisma.SecurityEventWhereInput[] = [];
      if (q.zone) {
        const clause = zoneFilterFor(links, q.zone, scope);
        // Missing, removed, hidden or unlinked: the same empty page, no query.
        if (clause === "none") {
          res.json({ events: [], nextCursor: null });
          return;
        }
        extraWhere.push(clause);
      }
      const page = await listSecurityEvents(
        prisma,
        feedVisibilityWhere(visible, scope.mayReadThreats),
        {
          limit: q.limit,
          cursor: cursor ?? undefined,
          kinds: q.kind ? { in: q.kind } : undefined,
          camera: q.camera,
          includeLow: q.includeLow,
        },
        extraWhere,
      );
      const areas = viewerAreas(links, scope);
      const incidents = await incidentOfEvents(
        prisma,
        page.events.map((e) => e.id),
      );
      res.json({
        ...page,
        events: page.events.map((e) => {
          const incidentId = incidents.get(e.id);
          return {
            ...e,
            zones: zoneChipsFor(e, areas),
            incident: incidentId ? { id: incidentId } : null,
          };
        }),
      });
    } catch (err) {
      logger.error({ err }, "security feed read failed");
      // Never an empty 200 on an outage: an empty feed reads as a quiet site.
      res.status(503).json({ error: "SECURITY_FEED_UNAVAILABLE" });
    }
  });

  router.get("/security/health", requireRole(...SECURITY_VIEW_ROLES), async (req: Request, res: Response) => {
    try {
      const now = deps.now?.() ?? new Date();
      const ownerOrAdmin = mayReadThreats(req);
      const [state, siteMode, patterns, incidents, alerts] = await Promise.all([
        prisma.securityIngestState.findUnique({
          where: { id: "singleton" },
          select: { threatMirrorRanAt: true, retentionRanAt: true, retentionDeleted: true, retentionIncidentsDeleted: true },
        }),
        // Never throws: an unreadable mode is a `down` row, not a 503 of the header.
        securitySiteModeHealth(prisma, now),
        // WARP-2980 — never throws either. Visible to every viewer, with its
        // counts scoped to the viewer's cameras (DS-005); a scope that cannot
        // be read gives the row nothing to count (null), never "all".
        securityViewerScope(prisma, req, deps.resolve).then(
          (scope) => securityPatternsHealth(prisma, scope, now),
          (err: unknown) => {
            logger.warn({ err }, "security health: viewer scope unreadable for the patterns row");
            return securityPatternsHealth(prisma, null, now);
          },
        ),
        // WARP-2978 — never throw either. The alerts row names who is told:
        // owner/admin only, and not even computed for anyone else.
        securityIncidentsHealth(prisma, now),
        ownerOrAdmin ? securityAlertsHealth(prisma, deps.resolve, now) : Promise.resolve(undefined),
      ]);
      const sources = buildSecurityHealth({
        frigateConfigured: Boolean(config.FRIGATE_URL && config.FRIGATE_URL.trim()),
        ingest: securityIngestHealthState(),
        frigate: securityStatusSnapshot().get(null),
        state,
        siteMode,
        patterns,
        incidents,
        alerts,
        now,
      });
      // The threat source is only a row for the people who can see threats.
      res.json({ sources: ownerOrAdmin ? sources : sources.filter((s) => s.id !== "threat_mirror") });
    } catch (err) {
      logger.error({ err }, "security health read failed");
      res.status(503).json({ error: "SECURITY_HEALTH_UNAVAILABLE" });
    }
  });

  return router;
}
