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
 * P2b), each pinned by a test when it does.
 */
import { Router, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { principalFromRequest, visibleCameraNames } from "../services/camera-access.service.js";
import {
  buildSecurityHealth,
  feedVisibilityWhere,
  listSecurityEvents,
  parseFeedCursor,
  securityIngestHealthState,
} from "../services/security-events.service.js";
import { securityStatusSnapshot } from "../services/camera.service.js";
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
  })
  .strict();

function mayReadThreats(req: Request): boolean {
  return req.user?.role === "owner" || req.user?.role === "admin";
}

export function createSecurityRouter(prisma: PrismaClient): Router {
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
      const visible = await visibleCameraNames(prisma, principalFromRequest(req));
      // A camera outside the grant answers exactly like a camera with no
      // events — an empty page, never a 403 that confirms it exists.
      if (q.camera && visible !== "all" && !visible.has(q.camera)) {
        res.json({ events: [], nextCursor: null });
        return;
      }
      const page = await listSecurityEvents(prisma, feedVisibilityWhere(visible, mayReadThreats(req)), {
        limit: q.limit,
        cursor: cursor ?? undefined,
        kinds: q.kind ? { in: q.kind } : undefined,
        camera: q.camera,
        includeLow: q.includeLow,
      });
      res.json(page);
    } catch (err) {
      logger.error({ err }, "security feed read failed");
      // Never an empty 200 on an outage: an empty feed reads as a quiet site.
      res.status(503).json({ error: "SECURITY_FEED_UNAVAILABLE" });
    }
  });

  router.get("/security/health", requireRole(...SECURITY_VIEW_ROLES), async (req: Request, res: Response) => {
    try {
      const state = await prisma.securityIngestState.findUnique({
        where: { id: "singleton" },
        select: { threatMirrorRanAt: true, retentionRanAt: true, retentionDeleted: true },
      });
      const sources = buildSecurityHealth({
        frigateConfigured: Boolean(config.FRIGATE_URL && config.FRIGATE_URL.trim()),
        ingest: securityIngestHealthState(),
        frigate: securityStatusSnapshot().get(null),
        state,
        now: new Date(),
      });
      // The threat source is only a row for the people who can see threats.
      res.json({ sources: mayReadThreats(req) ? sources : sources.filter((s) => s.id !== "threat_mirror") });
    } catch (err) {
      logger.error({ err }, "security health read failed");
      res.status(503).json({ error: "SECURITY_HEALTH_UNAVAILABLE" });
    }
  });

  return router;
}
