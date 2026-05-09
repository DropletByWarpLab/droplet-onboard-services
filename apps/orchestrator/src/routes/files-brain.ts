/**
 * /api/files/brain/* routes (WARP-203).
 *
 * Implements the chat-attachment ingestion surface from spec §6.3 + §7:
 *
 *   POST /api/files/brain/upload   — multipart, ≤50MB, MIME allow-list.
 *                                     Inserts BrainMemoryItem, writes
 *                                     original bytes + manifest to disk,
 *                                     publishes MQTT, returns 202.
 *   GET  /api/files/brain          — list caller's items (paginated +
 *                                     filterable by source / chat).
 *   GET  /api/files/brain/:itemId  — return caller's item manifest.
 *
 * RBAC (spec §12) — every read/write is filtered by `req.user.username`.
 * A request from user A targeting user B's itemId returns 404 (not 403)
 * so we don't leak existence of other users' rows.
 *
 * The actual extract/embed/upsert work happens out-of-band in the
 * file-indexer service, which subscribes to the MQTT topic this route
 * publishes (see services/file-indexer/main.py).
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import multer, { MulterError } from "multer";
import { BrainMemoryItemStatus, type PrismaClient } from "@prisma/client";
import pino from "pino";
import {
  writeOriginal,
  writeManifest,
  streamExportZip,
  deleteItem,
  isPathUnderUser,
} from "../services/brain-memory.service.js";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { publish as mqttPublish } from "../services/mqtt.service.js";
import { publishRunOne } from "../services/transcription-bus.service.js";

// WARP-218 — per-item rolling-hour retry cap for /transcribe-now.
const TRANSCRIBE_NOW_RETRY_WINDOW_MS = 60 * 60 * 1000;
const TRANSCRIBE_NOW_RETRY_CAP = 3;

interface CapState {
  windowStartedAt: Date | null;
  attemptCount: number;
}

function isCapHit(
  state: CapState,
  now: Date = new Date(),
): { capped: boolean; retryAfterSeconds: number } {
  if (
    state.windowStartedAt === null ||
    now.getTime() - state.windowStartedAt.getTime() >
      TRANSCRIBE_NOW_RETRY_WINDOW_MS
  ) {
    return { capped: false, retryAfterSeconds: 0 };
  }
  if (state.attemptCount >= TRANSCRIBE_NOW_RETRY_CAP) {
    const windowExpiresAt =
      state.windowStartedAt.getTime() + TRANSCRIBE_NOW_RETRY_WINDOW_MS;
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

const logger = pino({ name: "files-brain-route" });

/**
 * MIME allow-list — must match the extractor set landed in
 * `services/file-indexer/extractors/registry.py`:
 *
 *   text + json + xml → text extractor          (WARP-201)
 *   pdf               → pdf extractor           (WARP-201)
 *   docx              → docx extractor          (WARP-201)
 *   image/*           → image extractor (OCR)   (WARP-201)
 *   audio/*           → audio extractor (ASR)   (WARP-197)
 *   email             → email extractor with recursive attachment dispatch (WARP-199)
 *   archive (zip/tar) → archive extractor with 5-layer bomb defense (WARP-200)
 *   video/*           → video extractor (subtitles-first, audio-fallback) (WARP-198)
 *
 * The list is intentionally explicit rather than wildcard-driven so a
 * user can't slip in `application/octet-stream` and end up indexing
 * binary noise. Adding a new MIME requires landing the matching
 * extractor first.
 */
const ALLOWED_MIMES = new Set<string>([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/x-markdown",
  "application/json",
  "application/xml",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/tiff",
  "image/webp",
  // WARP-197 — audio (faster-whisper ASR). MIME set mirrors
  // `audio.SUPPORTED_MIMES` in extractors/audio.py.
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/flac",
  "audio/webm",
  "audio/aac",
  // WARP-199 email extractor MIMEs:
  "message/rfc822",
  "application/vnd.ms-outlook",
  "application/x-msmail",
  // WARP-200 archive MIMEs — the file-indexer's archive extractor walks
  // members under bounded recursion + 5-layer bomb defense before any
  // member text is indexed.
  "application/zip",
  "application/x-zip-compressed",
  "application/x-tar",
  "application/gzip",
  "application/x-gzip",
  "application/x-bzip2",
  // WARP-198 — video MIMEs. The file-indexer's video extractor takes
  // a subtitles-first / audio-fallback approach: text-based subtitle
  // streams (srt/ass/ssa/mov_text/webvtt) are extracted via ffmpeg +
  // the `srt` library; otherwise the audio track is stripped to a
  // 16kHz mono WAV and dispatched through the WARP-197 audio
  // extractor (faster-whisper). 2 GB cap enforced upstream by
  // VIDEO_MAX_BYTES in the indexer's registry.
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
  "video/webm",
  "video/x-msvideo",
  "video/mpeg",
]);

const MAX_FILE_BYTES = 50 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
});

interface AuthedUser {
  id?: string;
  username?: string;
}

function getUserId(req: Request): string | null {
  const user = (req as Request & { user?: AuthedUser }).user;
  return user?.username ?? user?.id ?? null;
}

/** Coerce BigInt to plain number for JSON serialization. */
function serialize(item: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(item).map(([k, v]) => [
      k,
      typeof v === "bigint" ? Number(v) : v,
    ]),
  );
}

export function createFilesBrainRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── POST /api/files/brain/upload ──
  // Multer's error handler sits inline so we can map LIMIT_FILE_SIZE to
  // a 413 with a typed body (rather than the default Express 500).
  router.post(
    "/files/brain/upload",
    (req: Request, res: Response, next: NextFunction) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err instanceof MulterError && err.code === "LIMIT_FILE_SIZE") {
          res.status(413).json({
            error: "file_too_large",
            maxBytes: MAX_FILE_BYTES,
          });
          return;
        }
        if (err) {
          next(err);
          return;
        }
        next();
      });
    },
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = getUserId(req);
        if (!userId) {
          res.status(401).json({ error: "auth_required" });
          return;
        }
        const file = (req as Request & { file?: Express.Multer.File }).file;
        if (!file) {
          res.status(400).json({ error: "no_file" });
          return;
        }
        if (!ALLOWED_MIMES.has(file.mimetype)) {
          res
            .status(415)
            .json({ error: "unsupported_mime", mimeType: file.mimetype });
          return;
        }

        // Per spec §7: insert the row first (so the dashboard chip can
        // poll for status), THEN write the bytes, THEN write the
        // manifest, THEN publish. If any step fails the row stays
        // around with `indexedAt: null`; the caller can retry / GC.
        const chatId =
          typeof (req.body as Record<string, unknown>)?.chatId === "string"
            ? ((req.body as Record<string, unknown>).chatId as string)
            : null;
        // WARP-218: audio + video land in `queued_for_transcription` so the
        // file-indexer's daily ASR worker (or a manual /transcribe-now
        // override) drives them through the extractor — never the inline
        // brain_ingest path. Documents stay on the original 'indexing' path.
        const isAudioOrVideo =
          file.mimetype.startsWith("audio/") ||
          file.mimetype.startsWith("video/");
        const initialStatus: BrainMemoryItemStatus = isAudioOrVideo
          ? BrainMemoryItemStatus.queued_for_transcription
          : BrainMemoryItemStatus.indexing;
        const item = await prisma.brainMemoryItem.create({
          data: {
            userId,
            filename: file.originalname,
            mimeType: file.mimetype,
            bytes: BigInt(file.size),
            storagePath: "",
            // Cast through unknown rather than importing the Prisma enum
            // — the Prisma 5 generator emits a union type that this
            // string literal satisfies but TypeScript widens to `string`.
            source: "chat_attachment" as unknown as never,
            originatingChatId: chatId,
            status: initialStatus,
          },
        });
        const path = await writeOriginal(
          userId,
          item.id,
          file.originalname,
          file.buffer,
        );
        const updated = await prisma.brainMemoryItem.update({
          where: { id: item.id },
          data: { storagePath: path },
        });
        await writeManifest(userId, item.id, serialize(updated));

        try {
          mqttPublish("droplet/files/brain/uploaded", {
            itemId: item.id,
            userId,
            path,
            mimeType: file.mimetype,
            filename: file.originalname,
            originatingChatId: chatId,
          });
        } catch (e) {
          // MQTT publish is best-effort — the manifest on disk is the
          // durable signal the indexer falls back on.
          logger.warn(
            { err: e, itemId: item.id },
            "MQTT publish for brain upload failed (non-fatal)",
          );
        }

        res.status(202).json({ itemId: item.id, status: "indexing" });
      } catch (e) {
        next(e);
      }
    },
  );

  // ── GET /api/files/brain ──
  // Cursorless offset pagination. The dashboard list view doesn't
  // need cursor semantics (the backing store is small, per-user).
  // Supports source + originatingChatId filters per spec §8.
  router.get("/files/brain", async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      const limit = Math.min(
        Number.parseInt(String(req.query.limit ?? "50"), 10) || 50,
        200,
      );
      const offset =
        Number.parseInt(String(req.query.offset ?? "0"), 10) || 0;
      const where: Record<string, string | undefined> = { userId };
      if (typeof req.query.source === "string") {
        where.source = req.query.source;
      }
      if (typeof req.query.originatingChatId === "string") {
        where.originatingChatId = req.query.originatingChatId;
      }
      const [items, total] = await Promise.all([
        prisma.brainMemoryItem.findMany({
          where: where as never,
          orderBy: { uploadedAt: "desc" },
          take: limit,
          skip: offset,
        }),
        prisma.brainMemoryItem.count({ where: where as never }),
      ]);
      res.json({
        items: items.map((i) =>
          serialize(i as unknown as Record<string, unknown>),
        ),
        total,
        limit,
        offset,
      });
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/files/brain/export ──
  // Streams a zip of the caller's brain-memory items + a manifest.
  // Two scopes: ?all=1 (every item) or ?chatId=<id> (just the items
  // tagged to that chat via originatingChatId). The zip is streamed —
  // we never buffer the whole archive in memory — and headers are
  // written BEFORE piping so the browser can start saving immediately.
  router.get("/files/brain/export", async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      const all = req.query.all === "1" || req.query.all === "true";
      const chatId =
        typeof req.query.chatId === "string" && req.query.chatId.length > 0
          ? req.query.chatId
          : null;
      if (!all && !chatId) {
        res.status(400).json({
          error: "missing_scope",
          hint: "specify ?all=1 or ?chatId=<id>",
        });
        return;
      }
      const filenameTag = all ? "all" : chatId;
      // Headers must land before the stream pipe. Once `streamExportZip`
      // pipes into res it'll start writing bytes immediately.
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="brain-memory-${filenameTag}.zip"`,
      });
      await streamExportZip(
        prisma,
        userId,
        all ? { scope: { kind: "all" } } : { scope: { kind: "chat", chatId: chatId! } },
        res,
      );
    } catch (e) {
      // Headers are already on the wire by the time we reach here in
      // the streaming path, so we can't 500 cleanly. Bubble to the
      // express error handler which will close the response.
      next(e);
    }
  });

  // ── GET /api/files/brain/:itemId/download ──
  // Stream the original bytes of a single item. RBAC + zip-slip
  // defense match the export route.
  router.get("/files/brain/:itemId/download", async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      const item = await prisma.brainMemoryItem.findUnique({
        where: { id: req.params.itemId },
      });
      if (!item || item.userId !== userId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (!item.storagePath || !isPathUnderUser(userId, item.storagePath)) {
        // Path escaped the user's tree — refuse rather than serve it.
        res.status(404).json({ error: "not_found" });
        return;
      }
      try {
        await stat(item.storagePath);
      } catch {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": item.mimeType ?? "application/octet-stream",
        "Content-Disposition": `attachment; filename="${item.filename.replace(/"/g, "")}"`,
      });
      createReadStream(item.storagePath).pipe(res);
    } catch (e) {
      next(e);
    }
  });

  // ── POST /api/files/brain/:itemId/transcribe-now ──
  // WARP-218 — operator/dashboard override that promotes a queued (or
  // failed) item to immediate processing. Validates auth → ownership →
  // state → rolling-hour retry cap, then publishes
  // `droplet/transcription/run-one` so the file-indexer worker picks it
  // up out-of-band from the daily 03:00 cron. Cross-user requests 404
  // (no existence leak — same pattern as the GET / DELETE routes).
  router.post("/files/brain/:itemId/transcribe-now", async (req, res, next) => {
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
      if (!row || row.userId !== userId) {
        res.status(404).json({ error: "not_found" });
        return;
      }

      // Only queued or failed items are eligible. 'indexing' means the
      // worker is mid-flight; 'ready' is terminal. 409 either way.
      if (
        row.status !== BrainMemoryItemStatus.queued_for_transcription &&
        row.status !== BrainMemoryItemStatus.failed
      ) {
        res.status(409).json({ error: "invalid_state", status: row.status });
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

      // Flip a failed item back to queued so the worker treats it as a
      // fresh entry. Queued rows stay queued — the publish is the actual
      // promotion signal.
      if (row.status === BrainMemoryItemStatus.failed) {
        await prisma.brainMemoryItem.update({
          where: { id: itemId },
          data: { status: BrainMemoryItemStatus.queued_for_transcription },
        });
      }

      try {
        publishRunOne({ publish: mqttPublish }, { itemId, userId });
      } catch (e) {
        // MQTT publish is best-effort — the row's queued state is the
        // durable signal the daily worker falls back on.
        logger.warn(
          { err: e, itemId },
          "MQTT publish for transcribe-now failed (non-fatal)",
        );
      }

      res.status(202).json({
        itemId,
        status: BrainMemoryItemStatus.queued_for_transcription,
      });
    } catch (e) {
      next(e);
    }
  });

  // ── DELETE /api/files/brain/:itemId ──
  // Removes the row, cascades FileContentChunk via Prisma deleteMany,
  // and purges the on-disk dir. Cross-user → 404 (no existence leak).
  router.delete("/files/brain/:itemId", async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      const ok = await deleteItem(prisma, userId, req.params.itemId);
      if (!ok) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/files/brain/:itemId ──
  // RBAC: 404 (not 403) on cross-user access so the route doesn't leak
  // the existence of other users' itemIds via response-code timing.
  router.get("/files/brain/:itemId", async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      const itemId = req.params.itemId;
      const item = await prisma.brainMemoryItem.findUnique({
        where: { id: itemId },
      });
      if (!item || item.userId !== userId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(serialize(item as unknown as Record<string, unknown>));
    } catch (e) {
      next(e);
    }
  });

  return router;
}
