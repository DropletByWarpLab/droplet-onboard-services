/**
 * WARP-225 — `/api/me/context-stats/*` routes.
 *
 * Backs the dashboard's home widget + `/context` page. Per spec §RBAC:
 *   - every endpoint is `WHERE "userId" = req.user.username` at the SQL
 *     layer (the service module is the gatekeeper).
 *   - cross-user `:itemId` requests return 404 — never 403, never 200
 *     with empty body — to avoid leaking the existence of other users'
 *     items.
 *
 * Endpoints:
 *   GET  /api/me/context-stats              → ContextStatsSummary  (30s cache)
 *   GET  /api/me/context-stats/full         → ContextStatsFull     (60s cache)
 *   GET  /api/me/context-stats/queued       → QueuedItem[]         (5min cache)
 *   GET  /api/me/context-stats/failed       → FailedItem[]         (5min cache)
 *   POST /api/me/context-stats/failed/:id/retry
 *
 * The retry route flips a `failed` row back to `queued_for_transcription`
 * and publishes `droplet/transcription/run-one` so the file-indexer
 * picks it up, mirroring the WARP-218 transcribe-now path. Inherits the
 * same per-item rolling-hour retry cap (3/hr → 429 + Retry-After).
 */

import { Router, type Request } from "express";
import { BrainMemoryItemStatus, type PrismaClient } from "@prisma/client";
import {
  getSummary,
  getFull,
  getQueued,
  getFailed,
  userKeyPrefix,
} from "../services/context-stats.service.js";
import { invalidatePrefix } from "../services/cache.service.js";
import { publish as mqttPublish } from "../services/mqtt.service.js";
import { publishRunOne } from "../services/transcription-bus.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("me-context-stats-route");

// Same retry cap as WARP-218 transcribe-now. Kept in sync intentionally
// — the route below mirrors that file's semantics so a failed-then-retry
// click can't burn through the cap by ping-ponging between routes.
const RETRY_WINDOW_MS = 60 * 60 * 1000;
const RETRY_CAP = 3;

interface AuthedUser {
  id?: string;
  username?: string;
}

function getUserId(req: Request): string | null {
  const user = (req as Request & { user?: AuthedUser }).user;
  return user?.username ?? user?.id ?? null;
}

function isCapHit(
  state: { windowStartedAt: Date | null; attemptCount: number },
  now: Date = new Date(),
): { capped: boolean; retryAfterSeconds: number } {
  if (
    state.windowStartedAt === null ||
    now.getTime() - state.windowStartedAt.getTime() > RETRY_WINDOW_MS
  ) {
    return { capped: false, retryAfterSeconds: 0 };
  }
  if (state.attemptCount >= RETRY_CAP) {
    const windowExpiresAt =
      state.windowStartedAt.getTime() + RETRY_WINDOW_MS;
    return {
      capped: true,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((windowExpiresAt - now.getTime()) / 1000),
      ),
    };
  }
  return { capped: false, retryAfterSeconds: 0 };
}

export function createMeContextStatsRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── GET /api/me/context-stats ──
  router.get("/me/context-stats", async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      const data = await getSummary(prisma, userId);
      res.setHeader("Cache-Control", "private, max-age=30");
      res.json(data);
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/me/context-stats/full ──
  router.get("/me/context-stats/full", async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      const data = await getFull(prisma, userId);
      res.setHeader("Cache-Control", "private, max-age=60");
      res.json(data);
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/me/context-stats/queued ──
  router.get("/me/context-stats/queued", async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      const data = await getQueued(prisma, userId);
      res.setHeader("Cache-Control", "private, max-age=300");
      res.json({ items: data });
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/me/context-stats/failed ──
  router.get("/me/context-stats/failed", async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      const data = await getFailed(prisma, userId);
      res.setHeader("Cache-Control", "private, max-age=300");
      res.json({ items: data });
    } catch (e) {
      next(e);
    }
  });

  // ── POST /api/me/context-stats/failed/:itemId/retry ──
  // Flips a 'failed' row back to 'queued_for_transcription' and triggers
  // the file-indexer's run-one handler. Cross-user → 404 (no leak).
  // 429 + Retry-After on cap hit, mirroring the WARP-218 transcribe-now
  // handler so a click on "Retry" shares the same rolling-hour budget.
  router.post(
    "/me/context-stats/failed/:itemId/retry",
    async (req, res, next) => {
      try {
        const userId = getUserId(req);
        if (!userId) {
          res.status(401).json({ error: "auth_required" });
          return;
        }
        const itemId = req.params.itemId;
        const row = await prisma.brainMemoryItem.findUnique({
          where: { id: itemId },
        });
        // Cross-user OR non-existent OR not-failed → 404 (no leak).
        if (!row || row.userId !== userId) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        if (row.status !== BrainMemoryItemStatus.failed) {
          // Only failed rows are retry-eligible from this surface. Queued /
          // indexing / ready rows aren't actionable here; surface a 409 so
          // a buggy double-click doesn't silently no-op.
          res
            .status(409)
            .json({ error: "invalid_state", status: row.status });
          return;
        }

        const cap = isCapHit({
          windowStartedAt: row.recentAttemptWindowStartedAt,
          attemptCount: row.recentAttemptCount,
        });
        if (cap.capped) {
          res.setHeader("Retry-After", String(cap.retryAfterSeconds));
          res.status(429).json({
            error: "rate_limited",
            attemptsInWindow: row.recentAttemptCount,
            retryAfterSeconds: cap.retryAfterSeconds,
          });
          return;
        }

        await prisma.brainMemoryItem.update({
          where: { id: itemId },
          data: { status: BrainMemoryItemStatus.queued_for_transcription },
        });

        try {
          publishRunOne({ publish: mqttPublish }, { itemId, userId });
        } catch (e) {
          // MQTT publish is best-effort — the durable signal is the
          // queued status; the daily worker will pick it up.
          logger.warn(
            { err: e, itemId },
            "MQTT publish for retry failed (non-fatal)",
          );
        }

        // Drop this user's cached drill-downs so the next poll shows the
        // updated status without waiting for the 5min TTL.
        await invalidatePrefix(userKeyPrefix(userId));

        res.status(202).json({
          itemId,
          status: BrainMemoryItemStatus.queued_for_transcription,
        });
      } catch (e) {
        next(e);
      }
    },
  );

  return router;
}
