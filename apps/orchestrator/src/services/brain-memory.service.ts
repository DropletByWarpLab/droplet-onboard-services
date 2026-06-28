/**
 * Brain-memory filesystem helpers (WARP-203).
 *
 * Owns the on-disk layout described in spec §6.2:
 *
 *   /data/brain-memory/
 *     <userId>/
 *       <itemId>/
 *         original.<ext>     — original bytes (multipart upload buffer)
 *         extracted.txt      — written by file-indexer after extraction
 *         manifest.json      — mirrors the BrainMemoryItem row
 *
 * The dir is bind-mounted into both the orchestrator (writes original
 * + manifest) and the file-indexer (writes extracted.txt + updated
 * manifest after embedding) — see docker-compose.yml `brain-memory-data`.
 *
 * `BRAIN_ROOT` is read from `BRAIN_MEMORY_ROOT` env at module load. The
 * production default `/data/brain-memory` is the bind-mount target. Tests
 * pin it to a tempdir before importing the module.
 *
 * Per-user RBAC is enforced at the route layer (see routes/files-brain.ts);
 * `isPathUnderUser` is a defense-in-depth helper for callers that need
 * to validate a path argument resolves below a user's tree.
 */

import { mkdir, writeFile, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import type { Response } from "express";
import type { PrismaClient, Prisma } from "@prisma/client";
import archiver from "archiver";

export const BRAIN_ROOT =
  process.env.BRAIN_MEMORY_ROOT ?? "/data/brain-memory";

/** Path to the per-item directory. Does NOT create it. */
export function pathForItem(userId: string, itemId: string): string {
  return join(BRAIN_ROOT, userId, itemId);
}

/** Create the per-item directory (recursive) and return its path. */
export async function ensureItemDir(
  userId: string,
  itemId: string,
): Promise<string> {
  const dir = pathForItem(userId, itemId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Write the uploaded bytes into the per-item directory as
 * `original.<ext>` (preserving the original filename's extension so
 * mime/extension-driven tooling outside the orchestrator can still
 * pick it up — file-indexer's extractor dispatch reads the row's
 * stored MIME, but the suffix on disk matters for ad-hoc inspection).
 *
 * Returns the absolute on-disk path. Filenames without an extension
 * are written as plain `original`.
 */
export async function writeOriginal(
  userId: string,
  itemId: string,
  filename: string,
  bytes: Buffer,
): Promise<string> {
  const dir = await ensureItemDir(userId, itemId);
  const ext = extname(filename);
  // Drop the leading dot so the literal output is `original.pdf`, not
  // `original..pdf`.
  const basename = ext ? `original${ext}` : "original";
  const path = join(dir, basename);
  await writeFile(path, bytes);
  return path;
}

/**
 * Write the manifest mirroring the BrainMemoryItem row. We ensure the
 * dir exists first because the manifest can be written from the
 * file-indexer side before the orchestrator's `writeOriginal` (in
 * principle — in practice the upload route is what creates the dir).
 */
export async function writeManifest(
  userId: string,
  itemId: string,
  manifest: object,
): Promise<void> {
  const dir = await ensureItemDir(userId, itemId);
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
}

/**
 * Remove just this item's directory. Used by the WARP-205 delete route
 * (and exposed here for completeness even though that route lives in
 * a sibling ticket).
 */
export async function purgeItem(
  userId: string,
  itemId: string,
): Promise<void> {
  await rm(pathForItem(userId, itemId), { recursive: true, force: true });
}

/**
 * Remove the entire per-user tree. Used by the cascade-on-user-deletion
 * path (WARP-205) and the test suite to reset between cases.
 */
export async function purgeUser(userId: string): Promise<void> {
  await rm(join(BRAIN_ROOT, userId), { recursive: true, force: true });
}

/**
 * Defense-in-depth path-traversal guard. Returns true iff `candidate`
 * resolves to a location strictly under `<BRAIN_ROOT>/<userId>/`.
 *
 * Routes already RBAC-check `BrainMemoryItem.userId === req.user.id`
 * before doing any filesystem work; this helper is for paths that
 * leak in via the manifest column (`storagePath`). A row that
 * somehow ended up with a tampered `storagePath` (manual SQL,
 * import bug) won't escape the user's tree.
 */
export function isPathUnderUser(userId: string, candidate: string): boolean {
  const root = resolve(BRAIN_ROOT, userId) + sep;
  const resolved = resolve(candidate);
  // `resolved + sep` lets us also accept the user's own root dir.
  return (resolved + sep).startsWith(root);
}

/**
 * Minimal subset of BrainMemoryItem the manifest consumer needs to
 * round-trip an item back into the system. Intentionally excludes raw
 * chunk text — the user can re-extract from the included file in the
 * zip — and `storagePath`, which would leak host filesystem layout.
 */
interface ManifestItem {
  id: string;
  filename: string;
  mimeType: string | null;
  bytes: number;
  source: string;
  originatingChatId: string | null;
  uploadedAt: string;
  indexedAt: string | null;
  chunkCount: number;
}

interface BrainMemoryItemRow {
  id: string;
  userId: string;
  filename: string;
  mimeType: string | null;
  bytes: bigint;
  storagePath: string;
  source: string;
  originatingChatId: string | null;
  uploadedAt: Date;
  indexedAt: Date | null;
}

export interface StreamExportOpts {
  /** "all" → every item the user owns. "chat" → just one chat's items. */
  scope: { kind: "all" } | { kind: "chat"; chatId: string };
}

/**
 * Stream a zip archive of the user's brain-memory items into `res`.
 *
 * Layout of the produced zip:
 *
 *   manifest.json           (top-level — see ManifestItem fields above)
 *   <itemId>/<filename>     (one entry per item; bytes from disk)
 *
 * Streams; never buffers. Callers MUST set `Content-Type` +
 * `Content-Disposition` BEFORE invoking this. Errors during piping
 * propagate via the promise so the route can `next(err)` them.
 *
 * Defense-in-depth: each item's `storagePath` is verified to live
 * under the caller's `<BRAIN_ROOT>/<userId>/` tree before its bytes
 * are added to the archive. A row whose path escapes (manual SQL,
 * legacy data) is silently skipped — the manifest entry remains so
 * the user can see what was excluded, but the bytes don't leak.
 */
export async function streamExportZip(
  prisma: PrismaClient,
  userId: string,
  opts: StreamExportOpts,
  res: Response,
): Promise<void> {
  const where: Prisma.BrainMemoryItemWhereInput = { userId };
  if (opts.scope.kind === "chat") {
    where.originatingChatId = opts.scope.chatId;
  }
  const items: BrainMemoryItemRow[] = await prisma.brainMemoryItem.findMany({
    where,
    orderBy: { uploadedAt: "desc" },
  });

  const zip = archiver("zip");
  // Streaming-only: pipe before any append() so backpressure works.
  zip.pipe(res);
  zip.on("warning", (err) => {
    // ENOENT on a missing per-item file is recoverable (we logged the
    // skip in the manifest). Other warnings should fail loud.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  });

  const manifestItems: ManifestItem[] = [];
  try {
    for (const item of items) {
      const chunkCount = await prisma.fileContentChunk.count({
        where: { brainItemId: item.id },
      });

      manifestItems.push({
        id: item.id,
        filename: item.filename,
        mimeType: item.mimeType,
        bytes: Number(item.bytes),
        source: item.source,
        originatingChatId: item.originatingChatId,
        uploadedAt: item.uploadedAt.toISOString(),
        indexedAt: item.indexedAt ? item.indexedAt.toISOString() : null,
        chunkCount,
      });

      // Path-traversal guard: only stream bytes whose on-disk path
      // resolves under <BRAIN_ROOT>/<userId>/. Skip otherwise — the
      // manifest still captures the item so the user can see it.
      if (!item.storagePath || !isPathUnderUser(userId, item.storagePath)) {
        continue;
      }
      try {
        await stat(item.storagePath);
      } catch {
        // Missing on disk — manifest captured the row, skip the entry.
        continue;
      }
      zip.append(createReadStream(item.storagePath), {
        name: `${item.id}/${item.filename}`,
      });
    }

    const manifest = {
      userId,
      generatedAt: new Date().toISOString(),
      scope:
        opts.scope.kind === "chat"
          ? { chatId: opts.scope.chatId }
          : { all: true },
      items: manifestItems,
    };
    zip.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
  } finally {
    // archiver MUST be finalized even on error paths so it flushes
    // any buffered control records and lets the response end cleanly.
    await zip.finalize();
  }
}

/**
 * Delete a single brain-memory item: cascade chunks → row → on-disk
 * dir. Returns `false` if the item is missing or owned by another
 * user (callers should map that to a 404, never a 403, to avoid
 * leaking row existence).
 *
 * The chunk cascade lives here (not in a Prisma `onDelete: Cascade`
 * relation) because `FileContentChunk.brainItemId` is a nullable
 * scalar field, not a real FK — kept that way so the indexer can
 * write chunks before the parent row exists in some race scenarios.
 */
export async function deleteItem(
  prisma: PrismaClient,
  userId: string,
  itemId: string,
): Promise<boolean> {
  const item: BrainMemoryItemRow | null =
    await prisma.brainMemoryItem.findUnique({ where: { id: itemId } });
  if (!item || item.userId !== userId) {
    return false;
  }
  await prisma.fileContentChunk.deleteMany({ where: { brainItemId: itemId } });
  await prisma.brainMemoryItem.delete({ where: { id: itemId } });
  await purgeItem(userId, itemId);
  return true;
}

/**
 * Wholesale per-user purge. Wired from `routes/auth.ts` user-delete so
 * deleting a user removes every brain item, chunk, and on-disk byte
 * the user owned. Idempotent — safe to call on a user with no items.
 */
export async function purgeUserData(
  prisma: PrismaClient,
  userId: string,
): Promise<{ items: number; chunks: number }> {
  const chunkResult = await prisma.fileContentChunk.deleteMany({
    where: { userId, source: "brain" },
  });
  const itemResult = await prisma.brainMemoryItem.deleteMany({
    where: { userId },
  });
  await purgeUser(userId);
  return { items: itemResult.count, chunks: chunkResult.count };
}
