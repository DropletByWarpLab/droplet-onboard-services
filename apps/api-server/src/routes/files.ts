import { Router, Request, Response, NextFunction } from "express";
import * as path from "node:path";
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
import { cacheGet, cacheSet, cacheDel } from "../services/cache.service.js";
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

/** Safely publish an MQTT message — failures are non-fatal. */
function safePublish(topic: string, payload: unknown): void {
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
  if (anyErr?.code === "ENOENT") {
    res.status(404).json({ error: "File not found" });
    return;
  }
  next(err);
}

export function createFilesRouter(_prisma: PrismaClient): Router {
  const router = Router();

  // ── Multer error handler ──
  // Multer throws MulterError for size/count violations before the route handler.
  // We need to intercept these and return a 400 instead of letting them become 500s.
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

      const cacheKey = CACHE_PREFIX + filePath;
      const cached = await cacheGet<FileEntryInfo[]>(cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }

      const entries = await listDirectory(filePath);
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

      const absolutePath = await resolveAndValidatePath(filePath);
      const size = await getFileSize(absolutePath);
      const filename = path.basename(absolutePath);
      const ext = path.extname(filename).toLowerCase();

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );
      res.setHeader("Content-Length", size);
      res.setHeader(
        "Content-Type",
        ext === ".pdf" ? "application/pdf" : "application/octet-stream"
      );

      streamFile(absolutePath).pipe(res);
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Upload file(s) ──
  router.post("/files/upload", handleUpload, async (req, res, next) => {
    try {
      const targetPath = (req.query.path as string) || "/";
      const targetDir = await resolveAndValidatePath(targetPath);

      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        res.status(400).json({ error: "No files provided" });
        return;
      }

      const results = [];
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

      // Invalidate directory cache
      await cacheDel(CACHE_PREFIX + targetPath);

      // Notify via MQTT (non-fatal)
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

      const absolutePath = await resolveAndValidatePath(filePath);
      await deleteFile(absolutePath);

      // Invalidate parent directory cache
      const parentPath = path.dirname(filePath);
      await cacheDel(CACHE_PREFIX + parentPath);

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

      const absolutePath = await resolveAndValidatePath(parsed.data.path);
      await createDirectory(absolutePath);

      // Invalidate parent cache
      const parentPath = path.dirname(parsed.data.path);
      await cacheDel(CACHE_PREFIX + parentPath);

      res.json({ created: parsed.data.path });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  return router;
}
