/**
 * WARP-1505 (ADR-026) — /api/pm/work-items/:id/attachments and
 * /api/pm/attachments/:id: files on work items and on their comments.
 *
 * Its own router, like routes/pm/relations.ts and for the same reasons: the paths
 * are disjoint from native.ts's, the error vocabulary is its own, and several
 * concurrent changes edit native.ts. Mounted on the same `/api` prefix in app.ts
 * right after the relations router, so `mountModuleGates` covers it with the
 * `projects` module gate and tier floor off the `/api/pm` prefix — which also
 * keeps an external guest out: `modules/guest-shares.ts` names the only six
 * requests a guest may make under `/api/pm`, and none of these is one of them.
 *
 * Auth: mounted AFTER authMiddleware. PM is household-shared, so reads (list,
 * download) are open to any authenticated role that passes the module gate — the
 * same read check as the work item itself — and writes take `requireRole(...WRITE)`,
 * the split native.ts uses. Writes do NOT admit the MCP service principal: no
 * registered tool uploads a file.
 *
 * Upload: multer in front (the library and the streaming shape routes/files.ts
 * already uses) with a storage engine that streams the part to the
 * `pm-attachments` volume. The cap is enforced WHILE streaming; `Content-Length`
 * is only a fast refusal in front of it. One file per request, field `file`.
 *
 * Limits that protect the box, not just the file: uploads are rate-limited per IP
 * (the global backstop of 1,200 requests a minute would admit ~20 files of 25 MiB
 * a second), and refused with 507 while the volume is nearly full — a full disk
 * takes Postgres down with Projects, so the check happens BEFORE a byte is
 * accepted rather than after ENOSPC. The other three routes carry the standard
 * per-IP ceiling like the other fs-touching handlers (routes/files.ts).
 *
 * Download: `Content-Disposition: attachment` and `application/octet-stream` for
 * everything, except a server-verified raster image asked for with `?inline=1`,
 * which is served inline. Every response carries `nosniff` and a `sandbox` CSP
 * (`default-src 'none'; sandbox` for a download), so not even a mislabelled file
 * can run in the dashboard's origin.
 */
import { Router, type Response } from "express";
import multer, { MulterError } from "multer";
import { createReadStream } from "node:fs";
import { mkdir, stat, statfs } from "node:fs/promises";
import { pipeline } from "node:stream";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { config } from "../../config.js";
import { createLogger } from "../../lib/logger.js";
import { requireRole } from "../../middleware/auth.js";
import { createRateLimit, standardRateLimit } from "../../middleware/rate-limit.js";
import { actorOf } from "./actor.js";
import {
  abortUpload,
  beginUpload,
  deleteAttachment,
  finalizeUpload,
  getServableAttachment,
  listAttachments,
  PM_ATTACHMENT_ERRORS,
  type UploadTicket,
} from "../../services/pm/pm-attachments.service.js";
import { contentDisposition, isPreviewableType } from "../../services/pm/pm-attachment-content.js";
import {
  blobPath,
  createAttachmentStorage,
  type StoredAttachmentFile,
} from "../../services/pm/pm-attachment-storage.js";

const logger = createLogger("pm-attachments");

const WRITE = ["owner", "admin", "family"] as const;
const ADMIN_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

/** Multipart framing (boundaries, part headers) on top of the file itself. A
 *  declared Content-Length beyond cap + this cannot be a file within the cap. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/** Uploads per minute per IP. A drawer pastes or drops a handful of files at a
 *  time; this is a ceiling for a retry loop or a stolen session, not a pace. */
const UPLOADS_PER_MINUTE = 30;

const uploadQuerySchema = z.object({ comment_id: z.string().min(1).max(64).optional() });

/** What `fs.statfs` answers, as numbers (the router never asks for bigint). */
export interface VolumeSpace {
  bavail: number;
  bsize: number;
  blocks: number;
}

/**
 * Does the volume have room to take an upload? Free space (as an unprivileged
 * process sees it) must stay above max(2 x the per-file cap, 5% of the
 * filesystem): two maximal files of headroom for work in flight, and a share of
 * the disk the database and everything else keep to themselves.
 *
 * A volume whose space cannot be read is allowed through, and logged: the
 * ENOSPC mapping below remains the backstop, and an exotic filesystem must not
 * be able to switch uploads off.
 */
async function volumeHasRoom(
  root: string,
  maxBytes: number,
  space: (path: string) => Promise<VolumeSpace>,
): Promise<boolean> {
  try {
    // First upload on a fresh volume: the root may not exist yet.
    await mkdir(root, { recursive: true, mode: 0o700 });
    const fs = await space(root);
    const free = fs.bavail * fs.bsize;
    const total = fs.blocks * fs.bsize;
    return free >= Math.max(2 * maxBytes, 0.05 * total);
  } catch (err) {
    logger.warn({ err }, "could not read the attachment volume's free space; allowing the upload");
    return true;
  }
}

/** What the busboy parser says about a body that is not a well-formed multipart
 *  form. Those are the CLIENT's fault (400); anything else out of the parser or
 *  the engine is ours (and a server error). */
const MALFORMED_MULTIPART =
  /^(Malformed|Unexpected end|Multipart:|Missing Content-Type|Unsupported content type|Part terminated early)/;

function mapAttachmentError(err: unknown, res: Response, maxBytes: number): boolean {
  if (err instanceof MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: PM_ATTACHMENT_ERRORS.TOO_LARGE, maxBytes });
    } else {
      // too many files / parts / fields, or a part under the wrong field name
      res.status(400).json({ error: PM_ATTACHMENT_ERRORS.BAD_REQUEST });
    }
    return true;
  }
  if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOSPC") {
    res.status(507).json({ error: PM_ATTACHMENT_ERRORS.STORAGE_FULL });
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && !("code" in err) && MALFORMED_MULTIPART.test(msg)) {
    res.status(400).json({ error: PM_ATTACHMENT_ERRORS.BAD_REQUEST });
    return true;
  }
  switch (msg) {
    case PM_ATTACHMENT_ERRORS.WORK_ITEM_NOT_FOUND:
    case PM_ATTACHMENT_ERRORS.COMMENT_NOT_FOUND:
    case PM_ATTACHMENT_ERRORS.NOT_FOUND:
      res.status(404).json({ error: msg });
      return true;
    case PM_ATTACHMENT_ERRORS.FORBIDDEN:
      res.status(403).json({ error: msg });
      return true;
    case PM_ATTACHMENT_ERRORS.TYPE_BLOCKED:
    case PM_ATTACHMENT_ERRORS.TYPE_MISMATCH:
      res.status(415).json({ error: msg });
      return true;
    case PM_ATTACHMENT_ERRORS.EMPTY:
    case PM_ATTACHMENT_ERRORS.FILE_REQUIRED:
    case PM_ATTACHMENT_ERRORS.BAD_REQUEST:
      res.status(400).json({ error: msg });
      return true;
    default:
      return false;
  }
}

export interface PmAttachmentsRouterOptions {
  /** Storage root. Defaults to `config.PM_ATTACHMENTS_DIR`. */
  root?: string;
  /** Per-file cap in bytes. Defaults to `config.PM_ATTACHMENT_MAX_BYTES`. */
  maxBytes?: number;
  /** Uploads per minute per IP. Defaults to 30. */
  uploadsPerMinute?: number;
  /** Free-space probe. Defaults to `fs.statfs`; a seam so a test can say "full". */
  statfs?: (path: string) => Promise<VolumeSpace>;
}

export function createPmAttachmentsRouter(
  prisma: PrismaClient,
  opts: PmAttachmentsRouterOptions = {},
): Router {
  const router = Router();
  const root = opts.root ?? config.PM_ATTACHMENTS_DIR;
  const maxBytes = opts.maxBytes ?? config.PM_ATTACHMENT_MAX_BYTES;
  const space = opts.statfs ?? ((path: string) => statfs(path));
  // One limiter per router, not per module: the counter is this router's own.
  const uploadLimit = createRateLimit("pm-attachment-upload", {
    windowMs: 60_000,
    limit: opts.uploadsPerMinute ?? UPLOADS_PER_MINUTE,
  });

  // Read — any authenticated role, matching every other PM read.
  router.get("/pm/work-items/:id/attachments", standardRateLimit, async (req, res, next) => {
    try {
      const attachments = await listAttachments(prisma, req.params.id);
      // The cap travels with the list so the dashboard states the real number
      // instead of carrying a copy of it.
      res.json({ attachments, limits: { maxBytes } });
    } catch (err) {
      if (mapAttachmentError(err, res, maxBytes)) return;
      next(err);
    }
  });

  router.post("/pm/work-items/:id/attachments", uploadLimit, requireRole(...WRITE), async (req, res, next) => {
    let ticket: UploadTicket | undefined;
    try {
      const query = uploadQuerySchema.safeParse(req.query);
      if (!query.success) {
        res.status(400).json({ error: "invalid_request", details: query.error.flatten() });
        return;
      }
      if (!req.is("multipart/form-data")) {
        res.status(400).json({ error: PM_ATTACHMENT_ERRORS.BAD_REQUEST });
        return;
      }
      // Fast refusal: a body declared larger than any file within the cap can be
      // is not read at all. A chunked body has no declared length and is held
      // to the cap by the streaming limit below.
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes + MULTIPART_OVERHEAD_BYTES) {
        res.status(413).json({ error: PM_ATTACHMENT_ERRORS.TOO_LARGE, maxBytes });
        return;
      }

      // Not while the disk is nearly full: nothing is accepted, no row is made.
      if (!(await volumeHasRoom(root, maxBytes, space))) {
        res.status(507).json({ error: PM_ATTACHMENT_ERRORS.STORAGE_FULL });
        return;
      }

      const actorId = actorOf(req);
      ticket = await beginUpload(prisma, {
        actorId,
        workItemId: req.params.id,
        commentId: query.data.comment_id,
      });

      const parse = multer({
        storage: createAttachmentStorage(root, ticket.storageKey),
        // The same two parser settings routes/files.ts uses: UTF-8 names, and the
        // name handed over whole so the content policy's sanitiser (not the
        // parser) is the one place that decides what is kept of it.
        defParamCharset: "utf8",
        preservePath: true,
        limits: { fileSize: maxBytes, files: 1, fields: 2, fieldSize: 1024, parts: 4 },
      }).single("file");
      await new Promise<void>((resolve, reject) => {
        parse(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
      });

      const file = req.file as (Express.Multer.File & StoredAttachmentFile) | undefined;
      if (!file) throw new Error(PM_ATTACHMENT_ERRORS.FILE_REQUIRED);

      const attachment = await finalizeUpload(prisma, {
        ticket,
        workItemId: req.params.id,
        actorId,
        file,
        root,
      });
      res.status(201).json({ attachment });
    } catch (err) {
      // finalizeUpload cleans up after its own failures; everything earlier (the
      // parse, the cap, a client that went away) is cleaned up here. Idempotent.
      if (ticket) await abortUpload(prisma, ticket, root);
      if (mapAttachmentError(err, res, maxBytes)) return;
      next(err);
    }
  });

  router.get("/pm/attachments/:id", standardRateLimit, async (req, res, next) => {
    try {
      const attachment = await getServableAttachment(prisma, req.params.id);
      const path = blobPath(root, attachment.storageKey);
      let size: number | undefined;
      try {
        const info = await stat(path);
        if (info.isFile()) size = info.size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      // A READY row whose file is missing, or is not the size recorded, is a
      // damaged store (a restored volume, a manual cleanup). Say "gone", loudly
      // in the log, rather than serve bytes that are not the file.
      if (size === undefined || size !== attachment.sizeBytes) {
        logger.error(
          { attachmentId: attachment.id, expected: attachment.sizeBytes, found: size ?? null },
          "attachment blob is missing or does not match its row",
        );
        res.status(404).json({ error: PM_ATTACHMENT_ERRORS.NOT_FOUND });
        return;
      }

      // Mirrors routes/email.ts's attachment download: octet-stream and nosniff
      // on EVERY response, and a sandbox CSP, so a mislabelled file cannot run in
      // the dashboard's origin even if something opens it in place.
      res.setHeader("X-Content-Type-Options", "nosniff");

      const inline = req.query.inline === "1" && isPreviewableType(attachment.mimeType);
      // A download loads nothing at all (email.ts's policy). An inline image gets
      // the spec's plain `sandbox`: it must still be allowed to draw itself.
      res.setHeader("Content-Security-Policy", inline ? "sandbox" : "default-src 'none'; sandbox");
      if (inline) {
        // A thumbnail is fetched again every time the drawer opens, so it is
        // revalidated instead of re-sent. The blob is immutable (its key is
        // never reused), so the digest is a perfect validator — and the auth +
        // row check above runs on EVERY request, so a removed file is never
        // shown from a cache we control.
        res.setHeader("ETag", `"${attachment.sha256}"`);
        res.setHeader("Cache-Control", "private, no-cache");
        if (req.fresh) {
          res.status(304).end();
          return;
        }
      } else {
        // A download is saved by the user; nothing should keep a copy for them.
        res.setHeader("Cache-Control", "private, no-store");
      }
      res.setHeader("Content-Type", inline ? attachment.mimeType : "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        contentDisposition(inline ? "inline" : "attachment", attachment.fileName),
      );
      res.setHeader("Content-Length", String(size));
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      pipeline(createReadStream(path), res, (err) => {
        // A client that hung up is not worth a line; anything else is.
        if (err && (err as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE") {
          logger.warn({ err, attachmentId: attachment.id }, "attachment download interrupted");
        }
      });
    } catch (err) {
      if (mapAttachmentError(err, res, maxBytes)) return;
      next(err);
    }
  });

  router.delete("/pm/attachments/:id", standardRateLimit, requireRole(...WRITE), async (req, res, next) => {
    try {
      await deleteAttachment(
        prisma,
        { id: actorOf(req), isAdmin: ADMIN_ROLES.has(req.user?.role ?? "") },
        req.params.id,
        root,
      );
      res.json({ deleted: req.params.id });
    } catch (err) {
      if (mapAttachmentError(err, res, maxBytes)) return;
      next(err);
    }
  });

  return router;
}
