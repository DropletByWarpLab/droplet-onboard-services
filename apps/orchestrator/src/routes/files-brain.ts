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
import type { PrismaClient } from "@prisma/client";
import pino from "pino";
import {
  writeOriginal,
  writeManifest,
} from "../services/brain-memory.service.js";
import { publish as mqttPublish } from "../services/mqtt.service.js";

const logger = pino({ name: "files-brain-route" });

/**
 * MIME allow-list — must match the Phase-1 extractor set landed in
 * WARP-201 (`services/file-indexer/extractors/registry.py`):
 *
 *   text + json + xml → text extractor
 *   pdf               → pdf extractor
 *   docx              → docx extractor (msword as a graceful upgrade)
 *   image/*           → image extractor (OCR via tesseract)
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
