import { Router, Request, Response, NextFunction } from "express";
import * as path from "node:path";
import { Readable } from "node:stream";
import multer, { MulterError } from "multer";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import pino from "pino";
import {
  ncListFiles,
  ncUploadFile,
  ncDownloadFile,
  ncDeleteFile,
  ncCreateDirectory,
  ncListShares,
  ncMoveFile,
  ncCopyFile,
  ncGetFileId,
  ncListTrash,
  ncRestoreTrashItem,
  ncDeleteTrashItem,
  ncEmptyTrash,
  ncListVersions,
  ncRestoreVersion,
  ncSetFavorite,
  ncListFavorites,
  ncSearchFiles,
  ncListRecents,
  ncFetchThumbnail,
  ncCreateShareV2,
  ncUpdateShare,
  ncDeleteShare,
  ncListSharedWithMe,
  NextcloudOcsError,
} from "../services/nextcloud.client.js";
import type { BulkOperationResult } from "../types/index.js";
import { cacheGet, cacheSet, cacheDel } from "../services/cache.service.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";
import { publish } from "../services/mqtt.service.js";
import { config } from "../config.js";
import type { FileEntryInfo } from "../types/index.js";

const logger = pino({ name: "files-route" });

const CACHE_PREFIX = "files:list:";
const CACHE_TTL = 10;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_UPLOAD_SIZE_MB * 1024 * 1024 },
});

/**
 * Resolve the Nextcloud credential for this request. For JWT sessions the
 * token is looked up from the Redis-backed NC session store; for legacy
 * sessions the cookie IS the NC token. Throws a sentinel error that the
 * route handlers convert to 401 when no credential is available (e.g. the
 * session pre-dates the NC-session store or the user hasn't logged in
 * since the fix shipped).
 */
class MissingNcTokenError extends Error {
  constructor() {
    super("Nextcloud session is missing — please log in again");
    this.name = "MissingNcTokenError";
  }
}

async function getToken(req: Request): Promise<string> {
  const token = await resolveNcToken(req);
  if (!token) throw new MissingNcTokenError();
  return token;
}

/** Get the username from the authenticated request. */
function getUser(req: Request): string {
  return req.user?.username || "admin";
}

/** Safely publish an MQTT message — failures are non-fatal. */
function safePublish(topic: string, payload: Record<string, unknown>): void {
  try {
    publish(topic, payload);
  } catch (err) {
    logger.warn({ err, topic }, "MQTT publish failed (non-fatal)");
  }
}

/**
 * Map errors from the Nextcloud client + generic fallthroughs to HTTP responses.
 * OCS errors preserve their upstream status (400 for validation, 403 forbidden,
 * 404 not found, 997 not allowed) so the frontend can render the real message.
 */
function handleFileError(
  err: unknown,
  res: Response,
  next: NextFunction
): void {
  if (err instanceof MissingNcTokenError) {
    res.status(401).json({ error: err.message });
    return;
  }
  if (err instanceof NextcloudOcsError) {
    const status =
      err.ocsStatus >= 400 && err.ocsStatus < 600 ? err.ocsStatus : 400;
    res.status(status).json({ error: err.message });
    return;
  }
  const anyErr = err as any;
  if (anyErr?.message?.includes("404")) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  next(err);
}

export function createFilesRouter(_prisma: PrismaClient): Router {
  const router = Router();

  // ── Multer error handler ──
  function handleUpload(req: Request, res: Response, next: NextFunction) {
    upload.array("files", 20)(req, res, (err) => {
      if (err instanceof MulterError) {
        const messages: Record<string, string> = {
          LIMIT_FILE_SIZE: `File too large (max ${config.MAX_UPLOAD_SIZE_MB}MB)`,
          LIMIT_FILE_COUNT: "Too many files (max 20)",
          LIMIT_UNEXPECTED_FILE: 'Unexpected field name (use "files")',
        };
        res
          .status(400)
          .json({ error: messages[err.code] ?? `Upload error: ${err.message}` });
        return;
      }
      if (err) {
        next(err);
        return;
      }
      next();
    });
  }

  // ── List directory contents ──
  router.get("/files", async (req, res, next) => {
    try {
      const filePath = (req.query.path as string) || "/";
      const user = getUser(req);

      const cacheKey = CACHE_PREFIX + user + ":" + filePath;
      const cached = await cacheGet<FileEntryInfo[]>(cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }

      const entries = await ncListFiles(await getToken(req), user, filePath);
      await cacheSet(cacheKey, entries, CACHE_TTL);
      res.json(entries);
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Download a file ──
  router.get("/files/download", async (req, res, next) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: "path query parameter is required" });
        return;
      }

      const filename = path.basename(filePath);
      const ext = path.extname(filename).toLowerCase();

      const stream = await ncDownloadFile(await getToken(req), getUser(req), filePath);
      if (!stream) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader(
        "Content-Type",
        ext === ".pdf" ? "application/pdf" : "application/octet-stream"
      );

      const nodeStream = Readable.fromWeb(stream as any);
      nodeStream.pipe(res);
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Upload file(s) ──
  router.post("/files/upload", handleUpload, async (req, res, next) => {
    try {
      const targetPath = (req.query.path as string) || "/";

      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        res.status(400).json({ error: "No files provided" });
        return;
      }

      const token = await getToken(req);
      const user = getUser(req);
      const results: { name: string; path: string; size: number }[] = [];

      for (const file of files) {
        await ncUploadFile(token, user, targetPath, file.originalname, file.buffer);
        results.push({
          name: file.originalname,
          path:
            targetPath === "/"
              ? `/${file.originalname}`
              : `${targetPath}/${file.originalname}`,
          size: file.size,
        });
      }

      await cacheDel(CACHE_PREFIX + user + ":" + targetPath);
      safePublish(`droplet/files/${user}/uploaded`, {
        path: targetPath,
        files: results.map((r) => r.name),
        count: results.length,
      });

      res.json({ uploaded: results });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Delete a file or directory ──
  router.delete("/files", async (req, res, next) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: "path query parameter is required" });
        return;
      }

      const user = getUser(req);
      await ncDeleteFile(await getToken(req), user, filePath);

      const parentPath = path.posix.dirname(filePath) || "/";
      await cacheDel(CACHE_PREFIX + user + ":" + parentPath);

      safePublish(`droplet/files/${user}/deleted`, { path: filePath });
      res.json({ deleted: filePath });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Create a directory ──
  router.post("/files/mkdir", async (req, res, next) => {
    try {
      const schema = z.object({ path: z.string().min(1) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: "path is required", details: parsed.error.flatten() });
        return;
      }

      const user = getUser(req);
      await ncCreateDirectory(await getToken(req), user, parsed.data.path);

      const parentPath = path.posix.dirname(parsed.data.path) || "/";
      await cacheDel(CACHE_PREFIX + user + ":" + parentPath);

      res.json({ created: parsed.data.path });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Create a share link ──
  //
  // Accepts the full ShareCreateOptions surface (shareType / permissions /
  // expireDate / password / note / shareWith). Callers that pass only `path`
  // get a public read-only link from the defaults.
  router.post("/files/share", async (req, res, next) => {
    try {
      const schema = z.object({
        path: z.string().min(1),
        shareType: z.number().int().min(0).max(6).optional().default(3), // public link
        permissions: z.number().int().min(1).max(31).optional().default(1),
        expireDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "expireDate must be YYYY-MM-DD")
          .optional(),
        password: z.string().min(1).optional(),
        note: z.string().max(500).optional(),
        shareWith: z.string().min(1).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid share request",
          details: parsed.error.flatten(),
        });
        return;
      }

      const share = await ncCreateShareV2(await getToken(req), parsed.data.path, {
        shareType: parsed.data.shareType,
        permissions: parsed.data.permissions,
        expireDate: parsed.data.expireDate,
        password: parsed.data.password,
        note: parsed.data.note,
        shareWith: parsed.data.shareWith,
      });

      res.json(share);
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── List shares for a path ──
  router.get("/files/shares", async (req, res, next) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: "path query parameter is required" });
        return;
      }
      const shares = await ncListShares(await getToken(req), filePath);
      res.json({ shares });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ────────────────────────────────────────────────────────────
  //  Phase 1 — Rename / Move / Copy (single + bulk) + Trash + Versions
  // ────────────────────────────────────────────────────────────

  /** Invalidate listing caches for the given parent paths (source + destination). */
  async function invalidateParents(user: string, ...paths: string[]): Promise<void> {
    const parents = new Set<string>();
    for (const p of paths) {
      parents.add(path.posix.dirname(p) || "/");
    }
    for (const parent of parents) {
      await cacheDel(CACHE_PREFIX + user + ":" + parent);
    }
  }

  /**
   * Run an async operation over a list of inputs with bounded concurrency.
   *
   * Why not Promise.all? Nextcloud's WebDAV has a known race when concurrent
   * DELETE/MOVE requests hit the trashbin: one of the requests can 500 while
   * the file ends up half-moved (trash entry created but source not unlinked).
   * Keeping concurrency small (default 1) serializes against that race while
   * still letting the route handle large batches responsively.
   */
  async function runBulk<T, R>(
    items: T[],
    op: (item: T) => Promise<R>,
    concurrency: number = 1
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        results[idx] = await op(items[idx]);
      }
    });
    await Promise.all(workers);
    return results;
  }

  // ── Rename (POST /api/files/rename) ──
  router.post("/files/rename", async (req, res, next) => {
    try {
      const schema = z.object({
        path: z.string().min(1),
        newName: z
          .string()
          .min(1)
          .max(255)
          .regex(/^[^/\\]+$/, "newName cannot contain path separators"),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid rename request",
          details: parsed.error.flatten(),
        });
        return;
      }
      const { path: filePath, newName } = parsed.data;
      const parentDir = path.posix.dirname(filePath) || "/";
      const newPath = parentDir === "/" ? `/${newName}` : `${parentDir}/${newName}`;

      const user = getUser(req);
      await ncMoveFile(await getToken(req), user, filePath, newPath, false);

      await invalidateParents(user, filePath);
      safePublish(`droplet/files/${user}/renamed`, { from: filePath, to: newPath });
      res.json({ renamed: { from: filePath, to: newPath } });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Move (POST /api/files/move) ──
  router.post("/files/move", async (req, res, next) => {
    try {
      const schema = z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        overwrite: z.boolean().optional().default(false),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid move request", details: parsed.error.flatten() });
        return;
      }
      const { from, to, overwrite } = parsed.data;

      const user = getUser(req);
      await ncMoveFile(await getToken(req), user, from, to, overwrite);

      await invalidateParents(user, from, to);
      safePublish(`droplet/files/${user}/moved`, { from, to });
      res.json({ moved: { from, to } });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Copy (POST /api/files/copy) ──
  router.post("/files/copy", async (req, res, next) => {
    try {
      const schema = z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        overwrite: z.boolean().optional().default(false),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid copy request", details: parsed.error.flatten() });
        return;
      }
      const { from, to, overwrite } = parsed.data;

      const user = getUser(req);
      await ncCopyFile(await getToken(req), user, from, to, overwrite);

      await invalidateParents(user, to);
      safePublish(`droplet/files/${user}/copied`, { from, to });
      res.json({ copied: { from, to } });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Bulk delete (POST /api/files/bulk-delete) ──
  router.post("/files/bulk-delete", async (req, res, next) => {
    try {
      const schema = z.object({ paths: z.array(z.string().min(1)).min(1).max(200) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid bulk-delete request" });
        return;
      }
      const { paths } = parsed.data;
      const user = getUser(req);
      const token = await getToken(req);

      const results: BulkOperationResult[] = await runBulk(paths, async (p) => {
        try {
          await ncDeleteFile(token, user, p);
          return { path: p, ok: true };
        } catch (err: any) {
          return { path: p, ok: false, error: err?.message ?? "unknown error" };
        }
      });

      await invalidateParents(user, ...paths);
      const okCount = results.filter((r) => r.ok).length;
      safePublish(`droplet/files/${user}/bulk-deleted`, {
        count: okCount,
        total: paths.length,
      });

      const allOk = okCount === paths.length;
      res.status(allOk ? 200 : 207).json({ results });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Bulk move (POST /api/files/bulk-move) ──
  router.post("/files/bulk-move", async (req, res, next) => {
    try {
      const schema = z.object({
        paths: z.array(z.string().min(1)).min(1).max(200),
        toDir: z.string().min(1),
        overwrite: z.boolean().optional().default(false),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid bulk-move request" });
        return;
      }
      const { paths, toDir, overwrite } = parsed.data;
      const user = getUser(req);
      const token = await getToken(req);
      const normalizedDir = toDir.replace(/\/+$/, "") || "/";

      const results: BulkOperationResult[] = await runBulk(paths, async (p) => {
        try {
          const base = path.posix.basename(p);
          const dest = normalizedDir === "/" ? `/${base}` : `${normalizedDir}/${base}`;
          await ncMoveFile(token, user, p, dest, overwrite);
          return { path: p, ok: true };
        } catch (err: any) {
          return { path: p, ok: false, error: err?.message ?? "unknown error" };
        }
      });

      await invalidateParents(user, ...paths, normalizedDir + "/_");
      const okCount = results.filter((r) => r.ok).length;
      safePublish(`droplet/files/${user}/bulk-moved`, {
        toDir: normalizedDir,
        count: okCount,
        total: paths.length,
      });

      const allOk = okCount === paths.length;
      res.status(allOk ? 200 : 207).json({ results });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Bulk copy (POST /api/files/bulk-copy) ──
  router.post("/files/bulk-copy", async (req, res, next) => {
    try {
      const schema = z.object({
        paths: z.array(z.string().min(1)).min(1).max(200),
        toDir: z.string().min(1),
        overwrite: z.boolean().optional().default(false),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid bulk-copy request" });
        return;
      }
      const { paths, toDir, overwrite } = parsed.data;
      const user = getUser(req);
      const token = await getToken(req);
      const normalizedDir = toDir.replace(/\/+$/, "") || "/";

      const results: BulkOperationResult[] = await runBulk(paths, async (p) => {
        try {
          const base = path.posix.basename(p);
          const dest = normalizedDir === "/" ? `/${base}` : `${normalizedDir}/${base}`;
          await ncCopyFile(token, user, p, dest, overwrite);
          return { path: p, ok: true };
        } catch (err: any) {
          return { path: p, ok: false, error: err?.message ?? "unknown error" };
        }
      });

      await invalidateParents(user, normalizedDir + "/_");
      const okCount = results.filter((r) => r.ok).length;
      safePublish(`droplet/files/${user}/bulk-copied`, {
        toDir: normalizedDir,
        count: okCount,
        total: paths.length,
      });

      const allOk = okCount === paths.length;
      res.status(allOk ? 200 : 207).json({ results });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Trash: list (GET /api/files/trash) ──
  router.get("/files/trash", async (req, res, next) => {
    try {
      const items = await ncListTrash(await getToken(req), getUser(req));
      res.json({ items });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Trash: restore (POST /api/files/trash/restore) ──
  router.post("/files/trash/restore", async (req, res, next) => {
    try {
      const schema = z.object({ name: z.string().min(1) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "name is required" });
        return;
      }
      const user = getUser(req);
      await ncRestoreTrashItem(await getToken(req), user, parsed.data.name);
      safePublish(`droplet/files/${user}/trash-restored`, { name: parsed.data.name });
      res.json({ restored: parsed.data.name });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Trash: delete single item permanently (DELETE /api/files/trash/item) ──
  router.delete("/files/trash/item", async (req, res, next) => {
    try {
      const name = req.query.name as string;
      if (!name) {
        res.status(400).json({ error: "name query parameter is required" });
        return;
      }
      const user = getUser(req);
      await ncDeleteTrashItem(await getToken(req), user, name);
      safePublish(`droplet/files/${user}/trash-purged`, { name });
      res.json({ deleted: name });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Trash: empty (DELETE /api/files/trash) ──
  router.delete("/files/trash", async (_req, res, next) => {
    try {
      const user = getUser(_req);
      await ncEmptyTrash(await getToken(_req), user);
      safePublish(`droplet/files/${user}/trash-emptied`, {});
      res.json({ emptied: true });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Versions: list (GET /api/files/versions?path=...) ──
  router.get("/files/versions", async (req, res, next) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: "path query parameter is required" });
        return;
      }
      const user = getUser(req);
      const token = await getToken(req);
      const fileId = await ncGetFileId(token, user, filePath);
      if (fileId === null) {
        res.status(404).json({ error: "File not found" });
        return;
      }
      const versions = await ncListVersions(token, user, fileId);
      res.json({ fileId, versions });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Versions: restore (POST /api/files/versions/restore) ──
  router.post("/files/versions/restore", async (req, res, next) => {
    try {
      const schema = z.object({
        path: z.string().min(1),
        versionId: z.string().min(1),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid restore request" });
        return;
      }
      const { path: filePath, versionId } = parsed.data;
      const user = getUser(req);
      const token = await getToken(req);

      const fileId = await ncGetFileId(token, user, filePath);
      if (fileId === null) {
        res.status(404).json({ error: "File not found" });
        return;
      }
      await ncRestoreVersion(token, user, fileId, versionId);

      await invalidateParents(user, filePath);
      safePublish(`droplet/files/${user}/version-restored`, { path: filePath, versionId });
      res.json({ restored: { path: filePath, versionId } });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ────────────────────────────────────────────────────────────
  //  Phase 2 — Favorites / Recents / Search / Thumbnails / Shares V2
  // ────────────────────────────────────────────────────────────

  // Redis cache prefixes — let callers invalidate one feature independently.
  const FAVORITES_CACHE_PREFIX = "files:favorites:";
  const RECENTS_CACHE_PREFIX = "files:recents:";
  const SEARCH_CACHE_PREFIX = "files:search:";
  const FAVORITES_TTL = 15;
  const RECENTS_TTL = 15;
  const SEARCH_TTL = 5;

  // ── Favorite toggle (POST /api/files/favorite) ──
  router.post("/files/favorite", async (req, res, next) => {
    try {
      const schema = z.object({
        path: z.string().min(1),
        favorite: z.boolean(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid favorite request" });
        return;
      }
      const { path: filePath, favorite } = parsed.data;
      const user = getUser(req);
      await ncSetFavorite(await getToken(req), user, filePath, favorite);
      await cacheDel(FAVORITES_CACHE_PREFIX + user);
      safePublish(`droplet/files/${user}/favorited`, { path: filePath, favorite });
      res.json({ path: filePath, favorite });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Favorites list (GET /api/files/favorites) ──
  router.get("/files/favorites", async (req, res, next) => {
    try {
      const user = getUser(req);
      const cacheKey = FAVORITES_CACHE_PREFIX + user;
      const cached = await cacheGet<FileEntryInfo[]>(cacheKey);
      if (cached) {
        res.json({ items: cached });
        return;
      }
      const items = await ncListFavorites(await getToken(req), user);
      await cacheSet(cacheKey, items, FAVORITES_TTL);
      res.json({ items });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Recents (GET /api/files/recents) ──
  router.get("/files/recents", async (req, res, next) => {
    try {
      const limit = Math.max(
        1,
        Math.min(200, parseInt((req.query.limit as string) || "50", 10) || 50)
      );
      const user = getUser(req);
      const cacheKey = `${RECENTS_CACHE_PREFIX}${user}:${limit}`;
      const cached = await cacheGet<FileEntryInfo[]>(cacheKey);
      if (cached) {
        res.json({ items: cached });
        return;
      }
      const items = await ncListRecents(await getToken(req), user, limit);
      await cacheSet(cacheKey, items, RECENTS_TTL);
      res.json({ items });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Search (GET /api/files/search?q=...&mime=...) ──
  router.get("/files/search", async (req, res, next) => {
    try {
      const q = (req.query.q as string | undefined)?.trim() ?? "";
      if (!q) {
        res.status(400).json({ error: "q query parameter is required" });
        return;
      }
      if (q.length < 2) {
        res.json({ items: [] });
        return;
      }
      const mime = (req.query.mime as string | undefined)?.trim() || undefined;
      const limit = Math.max(
        1,
        Math.min(200, parseInt((req.query.limit as string) || "50", 10) || 50)
      );
      const user = getUser(req);
      const cacheKey = `${SEARCH_CACHE_PREFIX}${user}:${q}:${mime ?? ""}:${limit}`;
      const cached = await cacheGet<FileEntryInfo[]>(cacheKey);
      if (cached) {
        res.json({ items: cached });
        return;
      }
      const items = await ncSearchFiles(await getToken(req), user, {
        query: q,
        mime,
        limit,
      });
      await cacheSet(cacheKey, items, SEARCH_TTL);
      res.json({ items });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Thumbnail proxy (GET /api/files/thumbnail?path=...&x=...&y=...) ──
  router.get("/files/thumbnail", async (req, res, next) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: "path query parameter is required" });
        return;
      }
      const x = Math.max(
        16,
        Math.min(1024, parseInt((req.query.x as string) || "256", 10) || 256)
      );
      const y = Math.max(
        16,
        Math.min(1024, parseInt((req.query.y as string) || "256", 10) || 256)
      );
      const user = getUser(req);
      const token = await getToken(req);

      const fileId = await ncGetFileId(token, user, filePath);
      if (fileId === null) {
        res.status(404).json({ error: "File not found" });
        return;
      }
      const preview = await ncFetchThumbnail(token, fileId, x, y);
      if (!preview) {
        res.status(404).json({ error: "Preview unavailable" });
        return;
      }
      res.setHeader("Content-Type", preview.contentType);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.send(Buffer.from(preview.body));
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Update existing share (PUT /api/files/share/:id) ──
  router.put("/files/share/:id", async (req, res, next) => {
    try {
      const shareId = parseInt(req.params.id, 10);
      if (Number.isNaN(shareId)) {
        res.status(400).json({ error: "Invalid share id" });
        return;
      }
      const schema = z
        .object({
          permissions: z.number().int().min(1).max(31).optional(),
          password: z.string().optional(),
          expireDate: z.string().optional(),
          note: z.string().optional(),
        })
        .refine(
          (d) =>
            d.permissions !== undefined ||
            d.password !== undefined ||
            d.expireDate !== undefined ||
            d.note !== undefined,
          { message: "At least one field is required" }
        );
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid share update",
          details: parsed.error.flatten(),
        });
        return;
      }
      const token = await getToken(req);

      // OCS accepts one field per PUT — apply them sequentially.
      if (parsed.data.permissions !== undefined) {
        await ncUpdateShare(token, shareId, "permissions", String(parsed.data.permissions));
      }
      if (parsed.data.password !== undefined) {
        await ncUpdateShare(token, shareId, "password", parsed.data.password);
      }
      if (parsed.data.expireDate !== undefined) {
        await ncUpdateShare(token, shareId, "expireDate", parsed.data.expireDate);
      }
      if (parsed.data.note !== undefined) {
        await ncUpdateShare(token, shareId, "note", parsed.data.note);
      }
      res.json({ updated: shareId });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Revoke a share (DELETE /api/files/share/:id) ──
  router.delete("/files/share/:id", async (req, res, next) => {
    try {
      const shareId = parseInt(req.params.id, 10);
      if (Number.isNaN(shareId)) {
        res.status(400).json({ error: "Invalid share id" });
        return;
      }
      await ncDeleteShare(await getToken(req), shareId);
      res.json({ deleted: shareId });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Shared-with-me inbox (GET /api/files/shared-with-me) ──
  router.get("/files/shared-with-me", async (req, res, next) => {
    try {
      const shares = await ncListSharedWithMe(await getToken(req));
      res.json({ shares });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ────────────────────────────────────────────────────────────
  //  Phase 4 — Semantic content search (pgvector)
  // ────────────────────────────────────────────────────────────

  // ── GET /api/files/search/content?q=...&limit=20 ──
  //
  // Embeds the query string via the ai-gateway gRPC, then does a
  // cosine-similarity search against the FileContentChunk table using
  // pgvector. Each result carries the matched file path + a text snippet
  // so the frontend can render results without a second fetch.
  router.get("/files/search/content", async (req, res, next) => {
    try {
      const q = (req.query.q as string | undefined)?.trim() ?? "";
      if (!q || q.length < 2) {
        res.status(400).json({ error: "q must be at least 2 characters" });
        return;
      }
      const limit = Math.max(
        1,
        Math.min(100, parseInt((req.query.limit as string) || "20", 10) || 20)
      );
      const user = getUser(req);

      // Check Redis cache first (60s TTL on identical queries)
      const cacheKey = `semantic:${user}:${q}:${limit}`;
      const cached = await cacheGet<Array<{ path: string; score: number; text: string }>>(cacheKey);
      if (cached) {
        res.json({ results: cached });
        return;
      }

      // Lazy-import the gRPC embedding function. It's optional — if gRPC
      // isn't available (e.g. ai-gateway down), we return a helpful error
      // rather than a generic 500.
      let embedVec: number[];
      try {
        const { grpcEmbedText, isGrpcAvailable } = await import(
          "../services/ai-gateway.grpc-client.js"
        );
        if (!isGrpcAvailable()) {
          res.status(503).json({ error: "AI gateway not available for semantic search" });
          return;
        }
        const vectors = await grpcEmbedText([q]);
        if (!vectors || vectors.length === 0 || !Array.isArray(vectors[0])) {
          res.status(502).json({ error: "Embedding service returned no vectors" });
          return;
        }
        embedVec = vectors[0];
        // Validate every element is a finite number — a buggy/compromised gRPC
        // response with NaN/Infinity/strings would cause a Postgres cast error.
        if (!embedVec.every((v) => typeof v === "number" && Number.isFinite(v))) {
          res.status(502).json({ error: "Embedding service returned invalid vector" });
          return;
        }
      } catch (err) {
        logger.warn({ err }, "Semantic search: embedding failed");
        res.status(503).json({ error: "Embedding service unavailable" });
        return;
      }

      // pgvector cosine similarity — Prisma can't express <=> so we use raw SQL.
      // Two-step query: inner DISTINCT ON deduplicates per file (keeping the
      // best chunk), outer query sorts by score and applies the limit.
      const vecLiteral = `[${embedVec.join(",")}]`;
      const rows: Array<{ path: string; score: number; text: string }> =
        await _prisma.$queryRawUnsafe(
          `
          SELECT path, score, text FROM (
            SELECT DISTINCT ON ("ncFileId")
              "path",
              1 - ("embedding" <=> $1::vector) AS score,
              "text"
            FROM "FileContentChunk"
            WHERE "userId" = $2
            ORDER BY "ncFileId", "embedding" <=> $1::vector
          ) ranked
          ORDER BY score DESC
          LIMIT $3
          `,
          vecLiteral,
          user,
          limit
        );

      await cacheSet(cacheKey, rows, 60);
      res.json({ results: rows });
    } catch (err: any) {
      // Catch Prisma/pgvector-specific errors (e.g. vector extension missing,
      // invalid vector cast) and return 503 instead of leaking raw SQL in a 500.
      if (
        err?.code === "P2010" ||
        err?.message?.includes("vector") ||
        err?.message?.includes("does not exist")
      ) {
        logger.warn({ err }, "Semantic search: database error (pgvector?)");
        res.status(503).json({
          error: "Semantic search is not available. The pgvector extension may not be installed.",
        });
        return;
      }
      handleFileError(err, res, next);
    }
  });

  return router;
}
