import { Router } from "express";
import * as fs from "node:fs";
import pino from "pino";
import { config } from "../config.js";
import type { StorageStats } from "../types/index.js";

const logger = pino({ name: "storage-route" });

export function createStorageRouter(): Router {
  const router = Router();

  router.get("/storage", async (_req, res, next) => {
    try {
      const stats = await getStorageStats();
      res.json(stats);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

async function getStorageStats(): Promise<StorageStats> {
  const filesRoot = config.FILES_ROOT;

  // Ensure the files directory exists
  if (!fs.existsSync(filesRoot)) {
    fs.mkdirSync(filesRoot, { recursive: true });
  }

  try {
    // fs.statfs is available since Node 18.15
    const fsStats = await fs.promises.statfs(filesRoot);

    const total = fsStats.bsize * fsStats.blocks;
    const free = fsStats.bsize * fsStats.bfree;
    const available = fsStats.bsize * fsStats.bavail;
    const used = total - free;
    const percentage = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;

    return { used, total, available, percentage };
  } catch (err) {
    logger.warn({ err }, "fs.statfs failed — falling back to du");

    // Fallback: calculate used space by walking the directory
    const used = await calculateDirSize(filesRoot);
    return {
      used,
      total: 0,
      available: 0,
      percentage: 0,
    };
  }
}

async function calculateDirSize(dirPath: string): Promise<number> {
  let totalSize = 0;

  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = `${dirPath}/${entry.name}`;
      if (entry.isDirectory()) {
        totalSize += await calculateDirSize(fullPath);
      } else {
        try {
          const stat = await fs.promises.stat(fullPath);
          totalSize += stat.size;
        } catch {
          // Skip files we can't stat
        }
      }
    }
  } catch {
    // Skip directories we can't read
  }

  return totalSize;
}
