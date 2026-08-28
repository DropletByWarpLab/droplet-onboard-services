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

import { mkdir, writeFile, rm, stat, readdir } from "node:fs/promises";
import { createReadStream, renameSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import type { Response } from "express";
import type { PrismaClient, Prisma } from "@prisma/client";
import pino from "pino";
import archiver from "archiver";

import { shredDocumentKey, shredDocumentKeys } from "./document-key.service.js";

const logger = pino({ name: "brain-memory.service" });

/**
 * WARP-493: lowercase-hex UUID v4-shaped regex. We use UUIDs at v4 default
 * in Prisma, but the migrator only cares about the SHAPE (8-4-4-4-12) so
 * future v7 / v5 rows still pass. Anchored — entry names that merely
 * contain a UUID substring (e.g. `stefan-cruceru-${uuid}`) don't match
 * and stay candidates for rename or orphan logging.
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const BRAIN_ROOT =
  process.env.BRAIN_MEMORY_ROOT ?? "/data/brain-memory";

/**
 * CodeQL js/path-injection (#168–#171): `userId` / `itemId` reach the
 * filesystem straight from route params — `req.params.itemId` in
 * routes/files-brain.ts, `req.params.username` via `purgeUserData` in
 * routes/auth.ts. Both are opaque identifiers (a `User.id` UUID or a
 * pre-WARP-485 Nextcloud username; a `BrainMemoryItem.id` UUID), so a single
 * path segment is all they may ever be. The charset is Nextcloud's own
 * username rule (`a-zA-Z0-9`, space, `_.@-'`) — a superset of UUID — which
 * makes a separator, NUL or `..` impossible by construction.
 */
const PATH_SEGMENT_REGEX = /^[A-Za-z0-9 _.@'-]{1,128}$/;

function safeSegment(kind: "userId" | "itemId", value: string): string {
  if (!PATH_SEGMENT_REGEX.test(value) || value === "." || value === "..") {
    throw new Error(`brain-memory: invalid ${kind} (not a single path segment)`);
  }
  return value;
}

/**
 * Resolve `segments` under BRAIN_ROOT and refuse anything that lands outside
 * it. Belt-and-braces on top of `safeSegment` — and the normalize-then-
 * startsWith shape is the check CodeQL credits as a path-injection barrier.
 */
function resolveUnderRoot(...segments: string[]): string {
  const root = resolve(BRAIN_ROOT);
  const resolved = resolve(root, ...segments);
  if (!resolved.startsWith(root + sep)) {
    throw new Error("brain-memory: path escapes BRAIN_ROOT");
  }
  return resolved;
}

/**
 * Path to the per-item directory. Does NOT create it. Throws if either id is
 * not a single, traversal-free path segment (see `safeSegment`).
 */
export function pathForItem(userId: string, itemId: string): string {
  return resolveUnderRoot(
    safeSegment("userId", userId),
    safeSegment("itemId", itemId),
  );
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
  await rm(resolveUnderRoot(safeSegment("userId", userId)), {
    recursive: true,
    force: true,
  });
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
  // WARP-242 crypto-shred: destroy the item's DEK (all versions). This is
  // what makes the deletion hold against restic snapshots — old pg_dumps
  // still carry the dcv1 ciphertext, but with the wrapped DEK gone from the
  // live DB (and the doc-KEK keyfile excluded from the backup set) the
  // snapshots restore ciphertext that can never be decrypted off-box.
  await shredDocumentKey(prisma, `brain:${itemId}`);
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
  // WARP-242 crypto-shred: collect the item ids BEFORE deleting the rows so
  // every per-document DEK (`brain:<itemId>`) can be destroyed with them.
  const itemIds = await prisma.brainMemoryItem.findMany({
    where: { userId },
    select: { id: true },
  });
  const chunkResult = await prisma.fileContentChunk.deleteMany({
    where: { userId, source: "brain" },
  });
  await shredDocumentKeys(
    prisma,
    itemIds.map((i) => `brain:${i.id}`),
  );
  const itemResult = await prisma.brainMemoryItem.deleteMany({
    where: { userId },
  });
  await purgeUser(userId);
  return { items: itemResult.count, chunks: chunkResult.count };
}

/**
 * Result of one `migrateBrainMemoryDirectoryLayout` pass — kept explicit
 * (no nullable-from-absence) per CLAUDE.md "no guessing, ever".
 */
export interface BrainMemoryLayoutMigrationResult {
  /** Top-level dirs renamed from a Nextcloud username to a `User.id` UUID. */
  renamed: number;
  /** Top-level dirs that were already UUID-shaped and skipped. */
  skippedUuid: number;
  /**
   * Top-level dirs whose name did NOT match any `User.nextcloudUsername`.
   * Left in place on disk — operator decides whether to drop or
   * re-attribute. Surface for tests + logs; never used to mutate.
   */
  orphans: string[];
  /**
   * Cases where renaming would clobber an existing UUID-named target dir.
   * Both directories are left in place; operator must resolve manually.
   * Surface for tests + logs; never used to mutate.
   */
  conflicts: { username: string; uuid: string; reason: "uuid_dir_exists" }[];
}

/**
 * WARP-493 — one-shot boot migrator that flips pre-WARP-485 username-keyed
 * brain-memory directories to UUID-keyed names. (Originally authored under
 * WARP-488 / PR #275, reverted there because the read side hadn't flipped;
 * re-introduced here as part of the atomic cutover.)
 *
 * Pre-WARP-485, the OCS-auth fallback set `req.user.id` to the Nextcloud
 * user-id string (e.g. `stefan-cruceru`), and any brain-memory item
 * uploaded under that session landed at `BRAIN_ROOT/<username>/<itemId>/`.
 * Post-WARP-485 `req.user.id` is always a local `User.id` UUID, so the
 * pre-fix dirs become unreachable (per-user RBAC + `pathForItem()` won't
 * resolve to them under the new UUID-keyed scheme).
 *
 * The migrator walks `BRAIN_ROOT`, and for each top-level entry:
 *
 *   - UUID-shaped name        → already migrated; skip (idempotent).
 *   - Username-shaped name    → look up the matching `User` row by
 *                                `nextcloudUsername`. If found and the
 *                                destination UUID-named dir DOES NOT
 *                                exist, atomic-rename via `fs.renameSync`.
 *                                If the destination DOES exist, log a
 *                                conflict and SKIP — never overwrite
 *                                (that would be a data-loss bug).
 *   - No matching User row    → log as orphan, leave in place. The
 *                                operator decides whether to re-attribute
 *                                or drop.
 *
 * Designed to be called once per orchestrator boot. The on-disk filesystem
 * is the source of truth for which dirs exist; calling this on a converged
 * layout walks the dirs but performs zero renames (every entry hits the
 * UUID-shape skip branch).
 *
 * Atomic-rename invariant: `fs.renameSync` is a single inode-level move
 * on the same filesystem (the bind-mount target is one filesystem). No
 * partial-state window where files exist under both names.
 *
 * Safe on a missing `BRAIN_ROOT` (operator boots the orchestrator before
 * any brain-memory item has ever been written) — `ENOENT` on the top-level
 * `readdir` is treated as "no work" and returns zeroed counters.
 */
export async function migrateBrainMemoryDirectoryLayout(
  prisma: PrismaClient,
  brainRoot: string,
): Promise<BrainMemoryLayoutMigrationResult> {
  const result: BrainMemoryLayoutMigrationResult = {
    renamed: 0,
    skippedUuid: 0,
    orphans: [],
    conflicts: [],
  };

  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = await readdir(brainRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // First-boot path: the bind-mount target hasn't been populated
      // yet. Nothing to migrate.
      logger.debug(
        { brainRoot },
        "brain-memory root does not exist — skipping layout migration",
      );
      return result;
    }
    throw err;
  }

  for (const entry of entries) {
    // Only consider top-level directories — a stray file at the root
    // (`.DS_Store`, `manifest.json`, anything the operator dropped in)
    // is not a per-user tree.
    if (!entry.isDirectory()) {
      continue;
    }

    const name = entry.name;

    // Idempotency guard: already UUID-shaped, nothing to do.
    if (UUID_REGEX.test(name)) {
      result.skippedUuid += 1;
      continue;
    }

    // Resolve username → UUID via the WARP-485 mapping column.
    const userRow = (await (
      prisma as unknown as {
        user: {
          findUnique: (args: {
            where: { nextcloudUsername: string };
          }) => Promise<{ id: string; nextcloudUsername: string | null } | null>;
        };
      }
    ).user.findUnique({ where: { nextcloudUsername: name } })) as
      | { id: string; nextcloudUsername: string | null }
      | null;

    if (!userRow) {
      // Orphan: this username is not in the User directory. The dir is
      // either pre-pairing junk or an OCS user that has not yet signed
      // in after WARP-485 (their `nextcloudUsername` would be written
      // on first sign-in). We DO NOT delete — the operator can decide.
      logger.warn(
        { brainRoot, username: name },
        "WARP-493: brain-memory dir has no matching User.nextcloudUsername — operator review needed (not deleted)",
      );
      result.orphans.push(name);
      continue;
    }

    const oldPath = join(brainRoot, name);
    const newPath = join(brainRoot, userRow.id);

    // Conflict guard: never overwrite an existing UUID-named target.
    // If both `BRAIN_ROOT/stefan-cruceru/` AND `BRAIN_ROOT/<uuid>/` exist,
    // the operator has to merge them manually (likely by moving items
    // from one to the other and re-running). Renaming over the UUID
    // dir would be a data-loss bug.
    let uuidDirExists = false;
    try {
      const s = await stat(newPath);
      uuidDirExists = s.isDirectory();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }

    if (uuidDirExists) {
      logger.warn(
        { brainRoot, username: name, uuid: userRow.id },
        "WARP-493: cannot rename brain-memory dir — UUID-named target already exists (operator merge required)",
      );
      result.conflicts.push({
        username: name,
        uuid: userRow.id,
        reason: "uuid_dir_exists",
      });
      continue;
    }

    // Atomic rename (same filesystem — the bind-mount target is one
    // device). renameSync because the loop is sequential per-user
    // anyway and the sync call has cleaner error semantics here than
    // fs/promises' rename for the no-partial-state guarantee.
    renameSync(oldPath, newPath);
    logger.info(
      { brainRoot, username: name, uuid: userRow.id },
      "WARP-493: renamed brain-memory dir username → UUID",
    );
    result.renamed += 1;
  }

  if (
    result.renamed > 0 ||
    result.orphans.length > 0 ||
    result.conflicts.length > 0
  ) {
    logger.info(
      {
        renamed: result.renamed,
        skippedUuid: result.skippedUuid,
        orphans: result.orphans.length,
        conflicts: result.conflicts.length,
      },
      "WARP-493: brain-memory directory layout migration complete",
    );
  }

  return result;
}
