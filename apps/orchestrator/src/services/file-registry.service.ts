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
 * `File.ncFileId` is `@unique`, so both operations here are single-row
 * indexed point reads/writes — no scans, no N+1.
 */
import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../lib/logger.js";

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
      },
      update: {
        ownerUserId: params.ownerUserId,
        path: params.path,
        departmentId: params.departmentId,
      },
    });
  } catch (err) {
    logger.warn(
      { err, ncFileId: params.ncFileId },
      "upsertFileRegistryEntry: non-fatal write failure",
    );
  }
}
