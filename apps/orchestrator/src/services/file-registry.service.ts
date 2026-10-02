/**
 * WARP-1260 (T8) — File-registry writer + O(1) `ncFileId → departmentId`
 * resolver.
 *
 * Repurposes the WARP-455 `File` model (schema-only until now — zero
 * Prisma-client usage per the ADR-029 ground-truth read) as the metadata
 * gate's lookup table: `routes/files.ts`'s comments/tags/citations/
 * editor-session routes resolve a file's owning department via
 * `resolveFileDepartment` before honoring the request, closing the
 * cross-department metadata leak the brief calls out (§3.2 — "fail-open =
 * cross-department metadata leak").
 *
 * `File.ncFileId` is `@unique`, so the per-request operations here are
 * single-row indexed point reads/writes — no scans, no N+1. The one batch
 * operation is the WARP-3425 reconcile sweep at the bottom.
 */
import { PrismaClient } from "@prisma/client";

import { createLogger } from "../lib/logger.js";
import { nextcloudDatabaseUrl } from "./company-link-audit.service.js";

const logger = createLogger("file-registry");

/**
 * Resolve the department a registered file belongs to. Returns `null`
 * both when the file has no registry row (personal-space files, or files
 * uploaded before this ticket / outside the upload route) and when a
 * registered row's `departmentId` is itself null (personal/household-
 * exempt) — either way the caller falls back to existing personal-space
 * semantics (per-user IDOR filters).
 */
export async function resolveFileDepartment(
  prisma: PrismaClient,
  ncFileId: number,
): Promise<string | null> {
  const row = await prisma.file.findUnique({
    where: { ncFileId },
    select: { departmentId: true },
  });
  return row?.departmentId ?? null;
}

export interface UpsertFileRegistryEntryParams {
  ncFileId: number;
  ownerUserId: string;
  path: string;
  departmentId: string | null;
  /** WARP-2096 — hex SHA-256 of the bytes written, and their length. */
  sha256?: string;
  sizeBytes?: number;
}

/**
 * Best-effort upsert of the File registry row, called right after a
 * successful Nextcloud upload. NEVER throws — a registry-write failure
 * must not fail the upload the user is actively waiting on; the file
 * simply falls back to personal-space metadata semantics (as if
 * unregistered) until the next write or a future reindex heals it.
 */
export async function upsertFileRegistryEntry(
  prisma: PrismaClient,
  params: UpsertFileRegistryEntryParams,
): Promise<void> {
  try {
    await prisma.file.upsert({
      where: { ncFileId: params.ncFileId },
      create: {
        ncFileId: params.ncFileId,
        ownerUserId: params.ownerUserId,
        path: params.path,
        departmentId: params.departmentId,
        sha256: params.sha256,
        sizeBytes: params.sizeBytes,
      },
      update: {
        ownerUserId: params.ownerUserId,
        path: params.path,
        departmentId: params.departmentId,
        sha256: params.sha256,
        sizeBytes: params.sizeBytes,
        // WARP-3425: the upload just proved Nextcloud has this id.
        status: "live",
      },
    });
  } catch (err) {
    logger.warn(
      { err, ncFileId: params.ncFileId },
      "upsertFileRegistryEntry: non-fatal write failure",
    );
  }
}

/**
 * WARP-2096 — registry rows holding the same bytes as a new upload, newest
 * first. Scoped to the SAME owner and the SAME space (departmentId, null =
 * personal): a wider lookup would hand the uploader another person's path,
 * and a deliberate personal→team copy is not a mistake worth flagging.
 *
 * Rows are CANDIDATES only. `missing` rows (WARP-3425) are left out, but the
 * registry still does not follow a rename or move and lags a delete by up to a
 * sweep, so the caller must confirm a row is still live before reporting it.
 * `excludeNcFileId` drops the file just written.
 */
export async function findSameContentCandidates(
  prisma: PrismaClient,
  params: {
    ownerUserId: string;
    departmentId: string | null;
    sha256: string;
    excludeNcFileId: number | null;
  },
): Promise<{ ncFileId: number; path: string | null }[]> {
  return prisma.file.findMany({
    where: {
      ownerUserId: params.ownerUserId,
      departmentId: params.departmentId,
      sha256: params.sha256,
      status: "live",
      ...(params.excludeNcFileId !== null ? { NOT: { ncFileId: params.excludeNcFileId } } : {}),
    },
    select: { ncFileId: true, path: true },
    orderBy: { updatedAt: "desc" },
    take: 3,
  });
}

// ── WARP-3425: reconcile the registry against Nextcloud ──────────────────────
//
// Rows are written on upload (`upsertFileRegistryEntry`) and, before this,
// nothing ever touched them again: DELETE /files, bulk delete, a trash purge,
// a delete in Nextcloud or a sync client, and a wiped group folder all left the
// row claiming the file existed. On the test box that was 33 Workspace rows for
// files Nextcloud no longer had, which read as "33 unindexed Workspace files".
//
// The sweep asks Nextcloud's own file cache which ids still exist, the way
// file-indexer resolves ids and `company-link-audit.service.ts` reads shares.
// It acts only on a positive answer: ids absent from a SUCCESSFUL query are
// gone (Nextcloud never reuses a file id). Any failure throws before a write.
//
// A gone row is marked `missing`, not deleted (see `File.status`). Its search
// index goes with it: the chunks and the FileIndexStatus row for that id are
// derived data that would otherwise keep a deleted document searchable, and
// they are exactly what file-indexer's own delete handler removes when it sees
// the delete happen. Nothing else is touched. Comments, tags, citations, CRM
// links and share records have no foreign key to this table, are written by
// people or record history, and stay behind the same department gate.

/** Bounds one sweep: one Nextcloud query and one transaction. A box with more
 *  rows is covered over several ticks. */
export const REGISTRY_SWEEP_BATCH = 500;

/** Last File.id the sweep examined; undefined = start from the beginning.
 *  In-process only: a restart costs one pass from the start. */
let registryCursor: string | undefined;

export function __resetRegistryCursorForTests(): void {
  registryCursor = undefined;
}

export interface FileRegistryReconcileResult {
  checked: number;
  markedMissing: number;
  restored: number;
  chunksDeleted: number;
  statusRowsDeleted: number;
}

/**
 * The subset of `ids` Nextcloud's file cache still holds. Read-only. THROWS on
 * any failure (database unreachable, table missing); a caller must treat a
 * throw as "unknown", never as "absent". A trashed file keeps its row, so it
 * counts as present.
 */
export async function queryExistingNcFileIds(ids: number[]): Promise<Set<number>> {
  const nc = new PrismaClient({ datasourceUrl: nextcloudDatabaseUrl() });
  try {
    const rows = await nc.$queryRaw<{ id: string }[]>`
      SELECT fileid::text AS id FROM oc_filecache WHERE fileid = ANY(${ids}::bigint[])`;
    return new Set(rows.map((r) => Number(r.id)));
  } finally {
    await nc.$disconnect();
  }
}

export async function reconcileFileRegistry(
  prisma: PrismaClient,
  existingNcFileIds: (ids: number[]) => Promise<Set<number>> = queryExistingNcFileIds,
): Promise<FileRegistryReconcileResult> {
  const result: FileRegistryReconcileResult = {
    checked: 0,
    markedMissing: 0,
    restored: 0,
    chunksDeleted: 0,
    statusRowsDeleted: 0,
  };
  const rows = await prisma.file.findMany({
    where: registryCursor !== undefined ? { id: { gt: registryCursor } } : {},
    select: { id: true, ncFileId: true, status: true },
    orderBy: { id: "asc" },
    take: REGISTRY_SWEEP_BATCH,
  });
  // Before anything is written: an outage throws here, changes nothing, and
  // leaves the cursor where it was.
  const present = rows.length > 0 ? await existingNcFileIds(rows.map((r) => r.ncFileId)) : new Set<number>();
  // A short page means the end: the next sweep starts over.
  registryCursor = rows.length === REGISTRY_SWEEP_BATCH ? rows[rows.length - 1]!.id : undefined;
  result.checked = rows.length;

  const gone = rows.filter((r) => r.status === "live" && !present.has(r.ncFileId)).map((r) => r.ncFileId);
  const back = rows.filter((r) => r.status === "missing" && present.has(r.ncFileId)).map((r) => r.ncFileId);
  if (gone.length === 0 && back.length === 0) return result;

  const [marked, chunks, statuses, restored] = await prisma.$transaction([
    prisma.file.updateMany({
      where: { ncFileId: { in: gone }, status: "live" },
      data: { status: "missing" },
    }),
    // `source: nextcloud` keeps brain-memory chunks (synthetic ids) out of it.
    prisma.fileContentChunk.deleteMany({ where: { ncFileId: { in: gone }, source: "nextcloud" } }),
    prisma.fileIndexStatus.deleteMany({ where: { ncFileId: { in: gone } } }),
    prisma.file.updateMany({
      where: { ncFileId: { in: back }, status: "missing" },
      data: { status: "live" },
    }),
  ]);
  result.markedMissing = marked.count;
  result.chunksDeleted = chunks.count;
  result.statusRowsDeleted = statuses.count;
  result.restored = restored.count;
  return result;
}
