/**
 * WARP-539 — 7-day GC of the per-update rollback backups.
 *
 * `applyPendingUpdate` step 1 (apply.ts → ApplyRunner.snapshot) writes
 * <updatesDir>/<updateId>/backup/ before it touches a single container:
 * the previous image refs (rollback pins), the host config tree pre-image,
 * and a `pg_dump --schema-only` of the orchestrator DB. That backup is the
 * rollback target while the update is in flight; the instant the update
 * reaches a TERMINAL status (committed / rolled_back / failed) it becomes
 * forensic-only, and on a box that takes a release every few weeks the
 * pile would grow without bound. This is the janitor.
 *
 * Wired into the existing daily 03:00 purge cron (index.ts) alongside the
 * schedule / audit / camera retention sweeps — one more line, one more log
 * field, same advisory-lock transaction.
 *
 * Safety rules (all enforced below, tested in purge-update-backups.test.ts):
 *   1. Only backups for a DeviceUpdate row in a TERMINAL status are ever
 *      considered — a pending / verifying / applying row's backup is the
 *      LIVE rollback target and is never touched, no matter how old.
 *   2. Age is the row's `updatedAt` (the moment it reached its terminal
 *      status), NOT the directory mtime. A box with a skewed clock or a
 *      filesystem that lost mtimes can't strand a backup forever or reap a
 *      fresh one early.
 *   3. A backup directory with NO matching DeviceUpdate row is left alone.
 *      It's either mid-write from a just-started apply (the row is created
 *      before the snapshot in the poller/apply flow, but a race or a
 *      hand-placed forensic dir shouldn't be our call to delete blind).
 *   4. Everything is best-effort per-update: one unreadable/locked dir logs
 *      a warn and the sweep moves on, so a single wedged backup can't block
 *      the GC of the rest.
 */
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type pino from "pino";
import { createLogger } from "../../lib/logger.js";

const defaultLog = createLogger("update-agent");

/** DeviceUpdate statuses whose backup is forensic-only (safe to GC). */
export const TERMINAL_UPDATE_STATUSES = ["committed", "rolled_back", "failed"] as const;

export interface PurgeUpdateBackupsOptions {
  /** Container path holding <updateId>/backup/ trees. */
  updatesDir: string;
  /** Backups for terminal updates older than this are removed. Default 7. */
  retentionDays?: number;
  logger?: pino.Logger;
  /** Clock injection for tests. */
  now?: () => number;
}

export interface PurgeUpdateBackupsResult {
  /** Number of per-update backup dirs removed. */
  purged: number;
}

/**
 * Remove <updatesDir>/<id>/backup for every terminal DeviceUpdate whose
 * terminal-transition (`updatedAt`) is older than the retention window.
 * The per-update parent dir is reaped too once its backup is gone (nothing
 * else lives under it). Returns the count for the cron's summary log line.
 */
export async function purgeUpdateBackups(
  prisma: PrismaClient,
  opts: PurgeUpdateBackupsOptions,
): Promise<PurgeUpdateBackupsResult> {
  const log = opts.logger ?? defaultLog;
  const retentionDays = opts.retentionDays ?? 7;
  const now = opts.now ? opts.now() : Date.now();

  if (!existsSync(opts.updatesDir)) {
    // Fresh box — no update has ever run, so no backups to sweep.
    return { purged: 0 };
  }

  const cutoff = new Date(now - retentionDays * 86400_000);
  const stale = await prisma.deviceUpdate.findMany({
    where: {
      status: { in: [...TERMINAL_UPDATE_STATUSES] },
      updatedAt: { lt: cutoff },
    },
    select: { id: true, status: true, updatedAt: true },
  });

  let purged = 0;
  for (const row of stale) {
    const updateDir = path.join(opts.updatesDir, row.id);
    const backupDir = path.join(updateDir, "backup");
    if (!existsSync(backupDir)) continue; // already GC'd or never snapshotted
    try {
      // Drop the whole per-update tree — backup/ is the only thing under it.
      await rm(updateDir, { recursive: true, force: true });
      purged += 1;
    } catch (err) {
      // One wedged/locked dir must not abort the sweep for the rest.
      log.warn(
        {
          event: "update.backup_purge_failed",
          deviceUpdateId: row.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "OTA backup GC could not remove a stale backup dir — leaving it for the next sweep",
      );
    }
  }

  if (purged > 0) {
    log.info(
      { event: "update.backup_purged", purged, retentionDays },
      "OTA backup GC removed stale rollback backups",
    );
  }
  return { purged };
}
