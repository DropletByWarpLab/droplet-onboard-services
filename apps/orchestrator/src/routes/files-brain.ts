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
import { createHash } from "node:crypto";
import {
  BrainMemoryItemStatus,
  BrainIngestPolicy,
  type BrainMemoryItem,
  type PrismaClient,
} from "@prisma/client";
import {
  writeOriginal,
  writeManifest,
  streamExportZip,
  deleteItem,
  isPathUnderUser,
} from "../services/brain-memory.service.js";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { inlinePreviewContentType } from "../lib/file-content.js";
import { publish as mqttPublish } from "../services/mqtt.service.js";
import { publishRunOne } from "../services/transcription-bus.service.js";
import { createLogger } from "../lib/logger.js";
import { standardRateLimit } from "../middleware/rate-limit.js";

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

const logger = createLogger("files-brain-route");

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

/**
 * WARP-493 — brain-memory keys on the local `User.id` UUID.
 *
 * `req.user.id` is guaranteed to be the local User UUID on every auth
 * path since WARP-485 (JWT `sub`; OCS fallback resolves through
 * `User.nextcloudUsername`). The pre-493 `username ?? id` preference
 * is what keyed rows/dirs by Nextcloud username — deliberately NOT
 * preserved anywhere. Pre-fix rows and dirs are converged by the
 * `warp_491_brain_memory_userid_backfill` SQL migration and the
 * boot-time `migrateBrainMemoryDirectoryLayout` pass, all shipping in
 * the same deploy as this flip.
 */
function getUserId(req: Request): string | null {
  const user = (req as Request & { user?: AuthedUser }).user;
  return user?.id ?? null;
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

/**
 * WARP-864 — a byte-identical re-upload reuses the existing item instead
 * of creating a duplicate row, storage dir, and re-ingest. Re-upload
 * signals current intent, so the item is re-homed to the new chat (the
 * attachment chip resolves in the conversation it was just used in). A
 * `failed` item gets its ingestion re-triggered instead of returning a
 * dead row. The stored filename is kept even when the re-upload used a
 * different name — `storagePath` embeds it, and the bytes are what we
 * deduplicate on.
 */
async function reuseExistingItem(
  prisma: PrismaClient,
  existing: BrainMemoryItem,
  chatId: string | null,
): Promise<{
  itemId: string;
  status: BrainMemoryItemStatus;
  deduplicated: true;
}> {
  const isAudioOrVideo =
    existing.mimeType?.startsWith("audio/") === true ||
    existing.mimeType?.startsWith("video/") === true;

  const data: { originatingChatId?: string } & Record<string, unknown> = {};
  if (chatId && chatId !== existing.originatingChatId) {
    data.originatingChatId = chatId;
  }
  const retrigger = existing.status === BrainMemoryItemStatus.failed;
  if (retrigger) {
    data.status = isAudioOrVideo
      ? BrainMemoryItemStatus.queued_for_transcription
      : BrainMemoryItemStatus.indexing;
    data.failureReason = null;
  }

  let item = existing;
  if (Object.keys(data).length > 0) {
    item = await prisma.brainMemoryItem.update({
      where: { id: existing.id },
      data: data as never,
    });
    await writeManifest(item.userId, item.id, serialize(item));
  }

  if (retrigger) {
    try {
      if (isAudioOrVideo) {
        // Audio/video re-ingest is driven by transcription_worker.run_one,
        // which subscribes to RUN_ONE_TOPIC — NOT droplet/files/brain/uploaded
        // (whose handler explicitly drops `queued_for_transcription` rows).
        // This mirrors the transcribe-now route. The worker's own
        // claim_attempt() still enforces the rolling-hour retry cap, so a
        // re-upload respects thrash-protection exactly like transcribe-now.
        publishRunOne(
          { publish: mqttPublish },
          { itemId: item.id, userId: item.userId },
        );
      } else {
        // Documents: handle_brain_uploaded does delete-then-insert on this
        // topic, re-extracting + re-embedding the existing bytes.
        mqttPublish("droplet/files/brain/uploaded", {
          itemId: item.id,
          userId: item.userId,
          path: item.storagePath,
          mimeType: item.mimeType,
          filename: item.filename,
          originatingChatId: item.originatingChatId,
        });
      }
    } catch (e) {
      logger.warn(
        { err: e, itemId: item.id },
        "MQTT publish for deduplicated re-upload failed (non-fatal)",
      );
    }
  }

  return { itemId: item.id, status: item.status, deduplicated: true };
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

        // WARP-905: optional ingest policy. Default 'auto_embed' preserves the
        // historical behaviour (embed immediately). 'await_approval' HOLDS the
        // upload — the file-indexer's brain_ingest gate + the daily ASR pass's
        // select_queued_items filter both skip await_approval rows, so nothing
        // is embedded until POST /files/brain/:id/approve releases it. Any
        // value other than the explicit 'await_approval' opt-in is auto_embed.
        const ingestPolicy: BrainIngestPolicy =
          (req.body as Record<string, unknown>)?.ingestPolicy ===
          BrainIngestPolicy.await_approval
            ? BrainIngestPolicy.await_approval
            : BrainIngestPolicy.auto_embed;

        // WARP-864: content-hash dedup. Re-uploading identical bytes
        // reuses the existing item (per user) instead of creating a
        // duplicate row + storage dir + full re-ingest.
        //
        // Known limitation (WARP-871): if a prior upload was hard-killed
        // between create() and writeOriginal(), its row carries this same
        // sha256 with storagePath="" and no bytes on disk. We still treat
        // it as a hit here — we can't synchronously tell that orphan apart
        // from a mid-write concurrent winner, and re-driving the latter
        // would reintroduce double-ingest. The orphan is DELETE-recoverable;
        // WARP-871 tracks reaping stale byte-less rows from the watchdog.
        const sha256 = createHash("sha256").update(file.buffer).digest("hex");
        const existing = await prisma.brainMemoryItem.findUnique({
          where: { userId_sha256: { userId, sha256 } },
        });
        if (existing) {
          res
            .status(202)
            .json(await reuseExistingItem(prisma, existing, chatId));
          return;
        }

        let item: BrainMemoryItem;
        try {
          item = await prisma.brainMemoryItem.create({
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
              ingestPolicy,
              sha256,
            },
          });
        } catch (e) {
          // Concurrent identical upload (double-click submit) lost the
          // race to the unique (userId, sha256) constraint — reuse the
          // winner's row instead of surfacing a 409.
          if ((e as { code?: unknown })?.code === "P2002") {
            const winner = await prisma.brainMemoryItem.findUnique({
              where: { userId_sha256: { userId, sha256 } },
            });
            if (winner) {
              res
                .status(202)
                .json(await reuseExistingItem(prisma, winner, chatId));
              return;
            }
            // P2002 fired but the winner is gone — it was deleted in the
            // microseconds between the constraint failure and this lookup.
            // The sha256 is free again, so a retry will succeed; surface a
            // typed 409 rather than re-throwing the raw Prisma error.
            res.status(409).json({ error: "concurrent_upload_conflict" });
            return;
          }
          throw e;
        }
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

        // WARP-905: only kick off ingestion when the policy is auto_embed.
        // A held (await_approval) upload is NOT published — it stays dormant
        // until POST /files/brain/:id/approve flips the policy and publishes.
        // Not-publishing is the fail-CLOSED guarantee: even if the indexer's
        // policy read later hiccups, a held file was never handed to it, so it
        // can't be embedded before a human approves. (The indexer's own policy
        // gate is defense-in-depth for any other publish path.)
        if (ingestPolicy === BrainIngestPolicy.auto_embed) {
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
        }

        // WARP-218: report the actual initial status so a direct
        // upload-response consumer (CLI, scripts, third-party clients)
        // sees `queued_for_transcription` for audio/video. The dashboard
        // uses GET to render the chip and is unaffected either way.
        // WARP-905: echo the ingest policy so the caller can immediately
        // render the "awaiting approval" affordance without a follow-up GET.
        res.status(202).json({ itemId: item.id, status: initialStatus, ingestPolicy });
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
  // CodeQL js/missing-rate-limiting — owner-scoped read that streams from
  // local disk; the standard per-IP preset is enough (no polling caller).
  router.get("/files/brain/:itemId/download", standardRateLimit, async (req, res, next) => {
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
      // WARP-2207: `?disposition=inline` flips this route from "save to disk"
      // to "render in place", so the chat file rail can show an attachment
      // instead of only offering to download it. Without it, feeding this URL
      // to an <object>/<img>/<video> makes the browser honour the attachment
      // header by DOWNLOADING — the same trap WARP-1919 fixed on
      // /api/files/download, which this branch mirrors.
      //
      // Inline is granted ONLY through `inlinePreviewContentType()`, the same
      // safelist that route uses. A brain item is arbitrary user-uploaded
      // content: `text/html` and `image/svg+xml` execute script, so rendering
      // one inline on the dashboard origin would be stored XSS against the
      // session cookie. The type is derived from the FILENAME, never from
      // `item.mimeType` — that column is attacker-influenced at upload time,
      // so trusting it here would let a row claiming application/pdf on an
      // .html file through. Off-safelist still downloads, exactly as before:
      // the affordance degrades, the invariant does not.
      const inlineType =
        req.query.disposition === "inline"
          ? inlinePreviewContentType(item.filename)
          : null;
      // RFC 6266 quoted-string: strip what would break out of the quoted
      // filename parameter.
      const dispositionFilename = item.filename.replace(/[\\"]/g, "");

      if (inlineType) {
        res.setHeader(
          "Content-Disposition",
          `inline; filename="${dispositionFilename}"`,
        );
        res.setHeader("Content-Type", inlineType);
        // `nosniff` stops a browser re-interpreting safelisted bytes as
        // markup; the `sandbox` CSP strips scripting/same-origin from the
        // rendered document even if a future edit widens the safelist.
        res.setHeader("X-Content-Type-Options", "nosniff");
        // application/pdf is EXEMPT from sandbox: Chromium's PDF viewer is
        // plugin-backed and renders blank inside a sandboxed document — the
        // regression WARP-1919 exists to fix. Safe, because PDF is not
        // same-origin-scriptable and the safelist already excludes every
        // scriptable type.
        if (inlineType !== "application/pdf") {
          res.setHeader("Content-Security-Policy", "sandbox");
        }
        res.status(200);
      } else {
        res.writeHead(200, {
          "Content-Type": item.mimeType ?? "application/octet-stream",
          "Content-Disposition": `attachment; filename="${dispositionFilename}"`,
        });
      }
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

      // WARP-905 — a held (ingestPolicy='await_approval') audio/video item
      // must NOT be pushed through transcription + embedding here. An
      // uploaded audio/video row lands at status='queued_for_transcription'
      // regardless of its ingest policy (initialStatus is derived purely from
      // MIME), so without this gate a held item would sail past the state +
      // rate-cap checks below and get published to the transcription worker —
      // bypassing the human approval gate entirely (a direct API caller or a
      // stale-UI race). The approval gate is owned by POST /approve, which
      // flips the policy to auto_embed and then drives the transcription
      // worker itself. Mirror the /approve route's ingestPolicy guard and
      // fail CLOSED: reject the promotion until the item is approved.
      if (row.ingestPolicy === BrainIngestPolicy.await_approval) {
        res.status(409).json({
          error: "awaiting_approval",
          ingestPolicy: row.ingestPolicy,
        });
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

  // ── POST /api/files/brain/:itemId/approve ──
  // WARP-905 — release an item held under ingestPolicy='await_approval'.
  // Flips the policy to 'auto_embed' and re-drives ingestion: audio/video go
  // through the transcription worker (publishRunOne); documents re-publish
  // `droplet/files/brain/uploaded` so brain_ingest (now unblocked by the
  // policy flip) extracts + embeds them. Idempotent-safe: a second call after
  // the flip returns 409 not_pending_approval. Cross-user → 404 (no existence
  // leak — same pattern as the other :itemId routes).
  router.post("/files/brain/:itemId/approve", async (req, res, next) => {
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
      if (row.ingestPolicy !== BrainIngestPolicy.await_approval) {
        res.status(409).json({
          error: "not_pending_approval",
          ingestPolicy: row.ingestPolicy,
        });
        return;
      }

      const updated = await prisma.brainMemoryItem.update({
        where: { id: itemId },
        data: { ingestPolicy: BrainIngestPolicy.auto_embed },
      });
      await writeManifest(userId, itemId, serialize(updated));

      const isAudioOrVideo =
        updated.mimeType?.startsWith("audio/") === true ||
        updated.mimeType?.startsWith("video/") === true;

      try {
        if (isAudioOrVideo) {
          // Held audio/video sits at status='queued_for_transcription'; the
          // daily pass skipped it while held. run_one drives it now.
          publishRunOne({ publish: mqttPublish }, { itemId, userId });
        } else {
          mqttPublish("droplet/files/brain/uploaded", {
            itemId,
            userId,
            path: updated.storagePath,
            mimeType: updated.mimeType,
            filename: updated.filename,
            originatingChatId: updated.originatingChatId,
          });
        }
      } catch (e) {
        // MQTT publish is best-effort — the flipped policy is the durable
        // signal (the daily pass now selects the row, or a re-upload re-drives
        // the document path).
        logger.warn(
          { err: e, itemId },
          "MQTT publish for brain approve failed (non-fatal)",
        );
      }

      res.status(202).json({
        itemId,
        status: updated.status,
        ingestPolicy: updated.ingestPolicy,
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
