import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import pino from "pino";
import { config } from "../config.js";
import type { FileEntryInfo } from "../types/index.js";

const logger = pino({ name: "file-service" });

let prisma: PrismaClient;

export function initFileService(prismaClient: PrismaClient): void {
  prisma = prismaClient;
}

export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathTraversalError";
  }
}

export class FileServiceError extends Error {
  public code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "FileServiceError";
    this.code = code;
  }
}

/**
 * Ensure FILES_ROOT directory exists and is writable.
 * Called once at the start of each path resolution.
 */
async function ensureFilesRoot(): Promise<void> {
  const filesRoot = config.FILES_ROOT;
  try {
    await fsp.mkdir(filesRoot, { recursive: true });
  } catch (err: any) {
    if (err.code === "EACCES") {
      throw new FileServiceError(
        `Permission denied: cannot create or access FILES_ROOT "${filesRoot}". ` +
          `Set the FILES_ROOT environment variable to a writable path.`,
        "EACCES"
      );
    }
    if (err.code === "ENOTDIR") {
      throw new FileServiceError(
        `FILES_ROOT path "${filesRoot}" contains a file where a directory is expected.`,
        "ENOTDIR"
      );
    }
    throw err;
  }
}

/**
 * Resolve a user-provided path and validate it stays within FILES_ROOT.
 * Prevents path traversal and symlink escape attacks.
 */
export async function resolveAndValidatePath(
  requestedPath: string
): Promise<string> {
  await ensureFilesRoot();

  // Use realpath on FILES_ROOT to resolve symlinks (e.g., /var → /private/var on macOS)
  const filesRoot = await fsp.realpath(config.FILES_ROOT);

  // Resolve the path relative to FILES_ROOT
  const resolved = path.resolve(filesRoot, requestedPath.replace(/^\/+/, ""));

  // Check prefix before realpath (file may not exist yet for upload/mkdir)
  if (!resolved.startsWith(filesRoot)) {
    throw new PathTraversalError(
      `Path "${requestedPath}" resolves outside allowed root`
    );
  }

  // If the path exists, also check realpath to catch symlink escapes
  try {
    const real = await fsp.realpath(resolved);
    if (!real.startsWith(filesRoot)) {
      throw new PathTraversalError(
        `Path "${requestedPath}" follows symlink outside allowed root`
      );
    }
    return real;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      // File doesn't exist yet — prefix check above is sufficient
      return resolved;
    }
    if (err instanceof PathTraversalError) throw err;
    throw err;
  }
}

export async function listDirectory(
  relativePath: string
): Promise<FileEntryInfo[]> {
  const dirPath = await resolveAndValidatePath(relativePath || "/");
  // Use realpath for consistent relative-path computation
  const filesRoot = await fsp.realpath(config.FILES_ROOT);

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    if (err.code === "ENOTDIR") throw new Error("Path is not a directory");
    throw err;
  }

  const result: FileEntryInfo[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    try {
      const stat = await fsp.stat(entryPath);
      const relPath = path.relative(filesRoot, entryPath);
      result.push({
        name: entry.name,
        path: "/" + relPath,
        isDirectory: entry.isDirectory(),
        size: Number(stat.size),
        mimeType: entry.isDirectory() ? null : guessMimeType(entry.name),
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch {
      // Skip entries we can't stat (broken symlinks, permission issues)
    }
  }

  // Sort: directories first, then alphabetical
  result.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return result;
}

export function streamFile(absolutePath: string): fs.ReadStream {
  return fs.createReadStream(absolutePath);
}

export async function saveUploadedFile(
  targetDir: string,
  filename: string,
  buffer: Buffer
): Promise<{ absolutePath: string; size: number; hash: string }> {
  try {
    await fsp.mkdir(targetDir, { recursive: true });
  } catch (err: any) {
    logger.error({ err, targetDir }, "Failed to create upload directory");
    if (err.code === "EACCES") {
      throw new FileServiceError(
        `Permission denied: cannot create directory "${targetDir}"`,
        "EACCES"
      );
    }
    throw err;
  }

  const filePath = path.join(targetDir, filename);
  try {
    await fsp.writeFile(filePath, buffer);
  } catch (err: any) {
    logger.error({ err, filePath }, "Failed to write uploaded file");
    if (err.code === "ENOSPC") {
      throw new FileServiceError("Disk full — cannot save file", "ENOSPC");
    }
    if (err.code === "EACCES") {
      throw new FileServiceError(
        `Permission denied: cannot write to "${filePath}"`,
        "EACCES"
      );
    }
    throw err;
  }

  const hash = await computeHash(filePath);
  return { absolutePath: filePath, size: buffer.length, hash };
}

export async function deleteFile(absolutePath: string): Promise<void> {
  const stat = await fsp.stat(absolutePath);
  if (stat.isDirectory()) {
    await fsp.rm(absolutePath, { recursive: true });
  } else {
    await fsp.unlink(absolutePath);
  }
}

/**
 * Move a file or directory. Overwrites the destination if `overwrite` is true,
 * otherwise throws with code `EEXIST`.
 */
export async function moveFile(
  absoluteFrom: string,
  absoluteTo: string,
  overwrite: boolean = false
): Promise<void> {
  if (!overwrite) {
    try {
      await fsp.access(absoluteTo);
      throw new FileServiceError(
        `Destination already exists: "${absoluteTo}"`,
        "EEXIST"
      );
    } catch (err: any) {
      if (err?.code !== "ENOENT" && !(err instanceof FileServiceError && err.code === "EEXIST")) {
        // Unexpected — rethrow
        if (err instanceof FileServiceError) throw err;
      }
      if (err instanceof FileServiceError) throw err;
    }
  }
  // Ensure destination parent exists
  await fsp.mkdir(path.dirname(absoluteTo), { recursive: true });
  await fsp.rename(absoluteFrom, absoluteTo);
}

/**
 * Copy a file or directory recursively. Overwrites existing files at the destination
 * only when `overwrite` is true.
 */
export async function copyFile(
  absoluteFrom: string,
  absoluteTo: string,
  overwrite: boolean = false
): Promise<void> {
  if (!overwrite) {
    try {
      await fsp.access(absoluteTo);
      throw new FileServiceError(
        `Destination already exists: "${absoluteTo}"`,
        "EEXIST"
      );
    } catch (err: any) {
      if (err instanceof FileServiceError) throw err;
      if (err?.code !== "ENOENT") throw err;
    }
  }
  await fsp.mkdir(path.dirname(absoluteTo), { recursive: true });
  const stat = await fsp.stat(absoluteFrom);
  if (stat.isDirectory()) {
    await fsp.cp(absoluteFrom, absoluteTo, { recursive: true, force: overwrite });
  } else {
    await fsp.copyFile(
      absoluteFrom,
      absoluteTo,
      overwrite ? 0 : fs.constants.COPYFILE_EXCL
    );
  }
}

export async function createDirectory(absolutePath: string): Promise<void> {
  try {
    await fsp.mkdir(absolutePath, { recursive: true });
  } catch (err: any) {
    if (err.code === "EACCES") {
      throw new FileServiceError(
        `Permission denied: cannot create directory "${absolutePath}"`,
        "EACCES"
      );
    }
    throw err;
  }
}

export async function computeHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath, {
      highWaterMark: 64 * 1024,
    });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export async function getFileSize(absolutePath: string): Promise<number> {
  const stat = await fsp.stat(absolutePath);
  return stat.size;
}

function guessMimeType(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".txt": "text/plain",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".xml": "application/xml",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".tar": "application/x-tar",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".csv": "text/csv",
    ".md": "text/markdown",
    ".py": "text/x-python",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".sh": "text/x-shellscript",
    ".log": "text/plain",
  };
  return map[ext] ?? "application/octet-stream";
}
