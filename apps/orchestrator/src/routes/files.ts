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
} from "../services/nextcloud.client.js";
import { cacheGet, cacheSet, cacheDel } from "../services/cache.service.js";
import { publish } from "../services/mqtt.service.js";
import { config } from "../config.js";
import type { FileEntryInfo } from "../types/index.js";

const logger = pino({ name: "files-route" });

const CACHE_PREFIX = "files:list:";
const CACHE_TTL = 10;
const isNextcloud = config.STORAGE_BACKEND === "nextcloud";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_UPLOAD_SIZE_MB * 1024 * 1024 },
});

/** Extract Bearer token from request. */
function getToken(req: Request): string {
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

  return router;
}
