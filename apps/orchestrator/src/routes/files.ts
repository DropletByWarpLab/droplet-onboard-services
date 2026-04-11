import { Router, Request, Response, NextFunction } from "express";
import * as path from "node:path";
import { Readable } from "node:stream";
import multer, { MulterError } from "multer";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import pino from "pino";
import {
  resolveAndValidatePath,
  listDirectory,
  streamFile,
  saveUploadedFile,
  deleteFile,
  createDirectory,
  moveFile as fsMoveFile,
  copyFile as fsCopyFile,
  getFileSize,
  PathTraversalError,
  FileServiceError,
} from "../services/file.service.js";
import {
  ncListFiles,
  ncUploadFile,
  ncDownloadFile,
  ncDeleteFile,
  ncCreateDirectory,
  ncCreateShare,
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
} from "../services/nextcloud.client.js";
import type { BulkOperationResult } from "../types/index.js";
import { cacheGet, cacheSet, cacheDel } from "../services/cache.service.js";
import { publish } from "../services/mqtt.service.js";
import { config } from "../config.js";
import { SESSION_COOKIE_NAME } from "../middleware/auth.js";
import type { FileEntryInfo } from "../types/index.js";

const logger = pino({ name: "files-route" });

const CACHE_PREFIX = "files:list:";
const CACHE_TTL = 10;
const isNextcloud = config.STORAGE_BACKEND === "nextcloud";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_UPLOAD_SIZE_MB * 1024 * 1024 },
});

/** Extract session token from cookie (browser) or Authorization header (API). */
function getToken(req: Request): string {
  const cookieToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (cookieToken) return cookieToken;

  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return "";
  return header.slice(7);
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

/** Handle FileServiceError / PathTraversalError with proper HTTP codes. */
function handleFileError(
  err: unknown,
  res: Response,
  next: NextFunction
): void {
  if (err instanceof PathTraversalError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof FileServiceError) {
    const status = err.code === "EACCES" || err.code === "ENOSPC" ? 503 : 500;
    res.status(status).json({ error: err.message });
    return;
  }
  const anyErr = err as any;
  if (anyErr?.code === "ENOENT" || anyErr?.message?.includes("404")) {
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

      let entries: FileEntryInfo[];
      if (isNextcloud) {
        entries = await ncListFiles(getToken(req), user, filePath);
      } else {
        entries = await listDirectory(filePath);
      }

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

      if (isNextcloud) {
        const stream = await ncDownloadFile(getToken(req), getUser(req), filePath);
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
      } else {
        const absolutePath = await resolveAndValidatePath(filePath);
        const size = await getFileSize(absolutePath);

        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("Content-Length", size);
        res.setHeader(
          "Content-Type",
          ext === ".pdf" ? "application/pdf" : "application/octet-stream"
        );

        streamFile(absolutePath).pipe(res);
      }
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

      const results = [];

      if (isNextcloud) {
        const token = getToken(req);
        const user = getUser(req);

        for (const file of files) {
          await ncUploadFile(token, user, targetPath, file.originalname, file.buffer);
          results.push({
            name: file.originalname,
            path: targetPath === "/" ? `/${file.originalname}` : `${targetPath}/${file.originalname}`,
            size: file.size,
          });
        }
      } else {
        const targetDir = await resolveAndValidatePath(targetPath);

        for (const file of files) {
          const { absolutePath, size, hash } = await saveUploadedFile(
            targetDir,
            file.originalname,
            file.buffer
          );

          results.push({
            name: file.originalname,
            path: "/" + path.relative(config.FILES_ROOT, absolutePath),
            size,
            hash,
          });
        }
      }

      // Invalidate directory cache
      const user = getUser(req);
      await cacheDel(CACHE_PREFIX + user + ":" + targetPath);

      safePublish("droplet/files/uploaded", {
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

      if (isNextcloud) {
        await ncDeleteFile(getToken(req), getUser(req), filePath);
      } else {
        const absolutePath = await resolveAndValidatePath(filePath);
        await deleteFile(absolutePath);
      }

      const user = getUser(req);
      const parentPath = path.dirname(filePath);
      await cacheDel(CACHE_PREFIX + user + ":" + parentPath);

      safePublish("droplet/files/deleted", { path: filePath });
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

      if (isNextcloud) {
        await ncCreateDirectory(getToken(req), getUser(req), parsed.data.path);
      } else {
        const absolutePath = await resolveAndValidatePath(parsed.data.path);
        await createDirectory(absolutePath);
      }

      const user = getUser(req);
      const parentPath = path.dirname(parsed.data.path);
      await cacheDel(CACHE_PREFIX + user + ":" + parentPath);

      res.json({ created: parsed.data.path });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Create a share link (Nextcloud only) ──
  router.post("/files/share", async (req, res, next) => {
    try {
      if (!isNextcloud) {
        res.status(501).json({ error: "Sharing requires Nextcloud backend" });
        return;
      }

      const schema = z.object({
        path: z.string().min(1),
        permissions: z.number().int().min(1).max(31).optional().default(1),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "path is required" });
        return;
      }

      const share = await ncCreateShare(
        getToken(req),
        parsed.data.path,
        3, // public link
        parsed.data.permissions
      );

      res.json(share);
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── List shares for a path (Nextcloud only) ──
  router.get("/files/shares", async (req, res, next) => {
    try {
      if (!isNextcloud) {
        res.json({ shares: [] });
        return;
      }

      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: "path query parameter is required" });
        return;
      }

      const shares = await ncListShares(getToken(req), filePath);
      res.json({ shares });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ────────────────────────────────────────────────────────────
  //  Phase 1 — Rename / Move / Copy (single + bulk) + Trash + Versions
  // ────────────────────────────────────────────────────────────

  /** Dispatch a single move across backends. Pure helper, no HTTP side effects. */
  async function doMove(
    token: string,
    user: string,
    from: string,
    to: string,
    overwrite: boolean
  ): Promise<void> {
    if (isNextcloud) {
      await ncMoveFile(token, user, from, to, overwrite);
    } else {
      const absFrom = await resolveAndValidatePath(from);
      const absTo = await resolveAndValidatePath(to);
      await fsMoveFile(absFrom, absTo, overwrite);
    }
  }

  async function doCopy(
    token: string,
    user: string,
    from: string,
    to: string,
    overwrite: boolean
  ): Promise<void> {
    if (isNextcloud) {
      await ncCopyFile(token, user, from, to, overwrite);
    } else {
      const absFrom = await resolveAndValidatePath(from);
      const absTo = await resolveAndValidatePath(to);
      await fsCopyFile(absFrom, absTo, overwrite);
    }
  }

  async function doDelete(
    token: string,
    user: string,
    filePath: string
  ): Promise<void> {
    if (isNextcloud) {
      await ncDeleteFile(token, user, filePath);
    } else {
      const abs = await resolveAndValidatePath(filePath);
      await deleteFile(abs);
    }
  }

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
      await doMove(getToken(req), user, filePath, newPath, false);

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
      await doMove(getToken(req), user, from, to, overwrite);

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
      await doCopy(getToken(req), user, from, to, overwrite);

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
      const token = getToken(req);

      const results: BulkOperationResult[] = await Promise.all(
        paths.map(async (p) => {
          try {
            await doDelete(token, user, p);
            return { path: p, ok: true };
          } catch (err: any) {
            return { path: p, ok: false, error: err?.message ?? "unknown error" };
          }
        })
      );

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
      const token = getToken(req);
      const normalizedDir = toDir.replace(/\/+$/, "") || "/";

      const results: BulkOperationResult[] = await Promise.all(
        paths.map(async (p) => {
          try {
            const base = path.posix.basename(p);
            const dest = normalizedDir === "/" ? `/${base}` : `${normalizedDir}/${base}`;
            await doMove(token, user, p, dest, overwrite);
            return { path: p, ok: true };
          } catch (err: any) {
            return { path: p, ok: false, error: err?.message ?? "unknown error" };
          }
        })
      );

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
      const token = getToken(req);
      const normalizedDir = toDir.replace(/\/+$/, "") || "/";

      const results: BulkOperationResult[] = await Promise.all(
        paths.map(async (p) => {
          try {
            const base = path.posix.basename(p);
            const dest = normalizedDir === "/" ? `/${base}` : `${normalizedDir}/${base}`;
            await doCopy(token, user, p, dest, overwrite);
            return { path: p, ok: true };
          } catch (err: any) {
            return { path: p, ok: false, error: err?.message ?? "unknown error" };
          }
        })
      );

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
      if (!isNextcloud) {
        res.status(501).json({ error: "Trash requires Nextcloud backend" });
        return;
      }
      const items = await ncListTrash(getToken(req), getUser(req));
      res.json({ items });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Trash: restore (POST /api/files/trash/restore) ──
  router.post("/files/trash/restore", async (req, res, next) => {
    try {
      if (!isNextcloud) {
        res.status(501).json({ error: "Trash requires Nextcloud backend" });
        return;
      }
      const schema = z.object({ name: z.string().min(1) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "name is required" });
        return;
      }
      const user = getUser(req);
      await ncRestoreTrashItem(getToken(req), user, parsed.data.name);
      safePublish(`droplet/files/${user}/trash-restored`, { name: parsed.data.name });
      res.json({ restored: parsed.data.name });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Trash: delete single item permanently (DELETE /api/files/trash/item) ──
  router.delete("/files/trash/item", async (req, res, next) => {
    try {
      if (!isNextcloud) {
        res.status(501).json({ error: "Trash requires Nextcloud backend" });
        return;
      }
      const name = req.query.name as string;
      if (!name) {
        res.status(400).json({ error: "name query parameter is required" });
        return;
      }
      const user = getUser(req);
      await ncDeleteTrashItem(getToken(req), user, name);
      safePublish(`droplet/files/${user}/trash-purged`, { name });
      res.json({ deleted: name });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Trash: empty (DELETE /api/files/trash) ──
  router.delete("/files/trash", async (_req, res, next) => {
    try {
      if (!isNextcloud) {
        res.status(501).json({ error: "Trash requires Nextcloud backend" });
        return;
      }
      const user = getUser(_req);
      await ncEmptyTrash(getToken(_req), user);
      safePublish(`droplet/files/${user}/trash-emptied`, {});
      res.json({ emptied: true });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Versions: list (GET /api/files/versions?path=...) ──
  router.get("/files/versions", async (req, res, next) => {
    try {
      if (!isNextcloud) {
        res.status(501).json({ error: "Versions require Nextcloud backend" });
        return;
      }
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: "path query parameter is required" });
        return;
      }
      const user = getUser(req);
      const token = getToken(req);
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
      if (!isNextcloud) {
        res.status(501).json({ error: "Versions require Nextcloud backend" });
        return;
      }
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
      const token = getToken(req);

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

  return router;
}
