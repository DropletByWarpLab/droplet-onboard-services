/**
 * WARP-225 — `/api/me/context-stats/*` routes.
 *
 * Backs the dashboard's home widget + `/context` page. Per spec §RBAC:
 *   - every endpoint is `WHERE "userId" = req.user.id` at the SQL
 *     layer (the service module is the gatekeeper). WARP-493: was
 *     `req.user.username` pre-cutover.
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
 * The retry route sends failed media back to `queued_for_transcription`
 * and failed documents to `indexing`, using each extractor's actual MQTT
 * topic. Held items must first be approved. Inherits the
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

// Same explicit formats accepted by files-brain upload, backed by extractors/registry.py.
// Retry must not send a failed document through the ASR-only worker or enqueue unsupported binary data.
const RETRY_MIMES = new Set([
  "text/plain", "text/markdown", "text/csv", "text/html", "text/x-markdown", "application/json", "application/xml", "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword",
  "image/jpeg", "image/png", "image/heic", "image/tiff", "image/webp",
  "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/ogg", "audio/flac", "audio/webm", "audio/aac",
  "message/rfc822", "application/vnd.ms-outlook", "application/x-msmail",
  "application/zip", "application/x-zip-compressed", "application/x-tar", "application/gzip", "application/x-gzip", "application/x-bzip2",
  "video/mp4", "video/quicktime", "video/x-matroska", "video/webm", "video/x-msvideo", "video/mpeg",
]);

interface AuthedUser {
  id?: string;
  username?: string;
}

/**
 * WARP-493 — brain-memory keys on the local `User.id` UUID (see the
 * same-named helper in routes/files-brain.ts for the full rationale).
 * Every aggregate this router serves reads BrainMemoryItem /
 * FileContentChunk rows whose userId flips to UUID in the same deploy
 * (warp_491_brain_memory_userid_backfill), and the transcribe-retry
 * run-one publish must carry the same key the transcription worker
 * will find on the row.
 */
function getUserId(req: Request): string | null {
  const user = (req as Request & { user?: AuthedUser }).user;
  return user?.id ?? null;
}

/**
 * WARP-1394 — Nextcloud-synced rows (`FileIndexStatus`, watcher-written
 * `FileContentChunk`) are keyed by the NEXTCLOUD username, which the
 * provisioning flow keeps equal to the local username (WARP-861 per-user
 * token). The UUID never appears in those tables, so the aggregates take
 * both keys. Falls back to the id for dev-shape callers that only stamp
 * an id.
 */
function getNcUsername(req: Request): string | null {
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
      const ncUsername = getNcUsername(req) ?? userId;
      const data = await getSummary(prisma, userId, ncUsername);
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
      const ncUsername = getNcUsername(req) ?? userId;
      const data = await getFull(prisma, userId, ncUsername);
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
      const ncUsername = getNcUsername(req) ?? userId;
      const data = await getQueued(prisma, userId, ncUsername);
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
      const ncUsername = getNcUsername(req) ?? userId;
      const data = await getFailed(prisma, userId, ncUsername);
      // Older appliances route every retry through ASR. Native clients must detect document ingestion support explicitly.
      res.json({ items: data, retryDocumentSupported: true });
    } catch (e) {
      next(e);
    }
  });

  // ── POST /api/me/context-stats/failed/:itemId/retry ──
  // Retry the caller's failed item using its actual extractor pipeline.
  // Cross-user → 404 (no leak).
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

        if (row.ingestPolicy === "await_approval") {
          res.status(409).json({ error: "awaiting_approval", ingestPolicy: row.ingestPolicy });
          return;
        }
        if (!row.mimeType || !RETRY_MIMES.has(row.mimeType)) {
          res.status(415).json({ error: "unsupported_mime" });
          return;
        }
        if (!row.hasOriginalBytes || !row.storagePath) {
          res.status(409).json({ error: "original_unavailable" });
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

        const media = row.mimeType.startsWith("audio/") || row.mimeType.startsWith("video/");
        const status = media ? BrainMemoryItemStatus.queued_for_transcription : BrainMemoryItemStatus.indexing;
        const now = new Date();
        const sameWindow = row.recentAttemptWindowStartedAt !== null && now.getTime() - row.recentAttemptWindowStartedAt.getTime() <= RETRY_WINDOW_MS;
        // Compare-and-set prevents concurrent requests or a policy/state change after the ownership read from publishing stale work.
        // The ASR worker owns its own attempt claim; document retries need the same rolling-hour counter here.
        const changed = await prisma.brainMemoryItem.updateMany({
          where: { id: itemId, userId, status: BrainMemoryItemStatus.failed, ingestPolicy: "auto_embed", mimeType: row.mimeType,
            hasOriginalBytes: true, storagePath: row.storagePath,
            recentAttemptCount: row.recentAttemptCount, recentAttemptWindowStartedAt: row.recentAttemptWindowStartedAt },
          data: { status, ...(!media ? { recentAttemptCount: sameWindow ? row.recentAttemptCount + 1 : 1,
            recentAttemptWindowStartedAt: sameWindow ? row.recentAttemptWindowStartedAt : now } : {}) },
        });
        if (changed.count !== 1) { res.status(409).json({ error: "state_changed" }); return; }

        try {
          if (media) { publishRunOne({ publish: mqttPublish }, { itemId, userId }); }
          else { mqttPublish("droplet/files/brain/uploaded", { itemId, userId, path: row.storagePath,
            mimeType: row.mimeType, filename: row.filename, originatingChatId: row.originatingChatId }); }
        } catch (e) {
          // Use the same best-effort publication contract as Brain upload/approval.
          // The response acknowledges a processing request, not completed extraction.
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
          status,
        });
      } catch (e) {
        next(e);
      }
    },
  );

  return router;
}
