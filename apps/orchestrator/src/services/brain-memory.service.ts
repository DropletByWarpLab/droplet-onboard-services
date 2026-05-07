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

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, extname, resolve, sep } from "node:path";

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
