/**
 * WARP-586 — retention purge for the append-only audit/log tables.
 *
 * Three tables are written continuously but had no retention, so they
 * grew unbounded:
 *   - ActivityRow      — signed, hash-chained activity log (WARP-456)
 *   - CommandAuditLog  — per-domain command audit (read view today)
 *   - NotificationLog  — delivery log for reminders/events/system/ai
 *
 * `purgeAuditLogs` deletes rows older than `olderThanDays` (driven by
 * `DROPLET_AUDIT_RETENTION_DAYS`, default 90) from all three, called
 * from the daily 03:00 cron in `index.ts`. Returns per-table deleted
 * counts so the cron logs one summary line.
 *
 * `olderThanDays <= 0` is the explicit "keep forever" / disabled state
 * (NOT a sentinel guessed from a missing column — same posture as the
 * camera-retention purge): the function deletes nothing and reports
 * zeros. This lets an operator turn retention off without code changes.
 *
 * Chain-integrity note for ActivityRow (the hash-chained table):
 * the chain is built in `id` order, each row's `signature` covering its
 * own content + `prevSignatureHash` (= SHA-256 of the prior row's
 * signature). We purge ONLY the oldest contiguous prefix — rows with
 * `at < cutoff` — which is a seal-and-truncate, not a mid-chain delete:
 *   - Every surviving row keeps its own columns untouched, so each one
 *     still self-verifies (`signer.verify(content, prevSignatureHash,
 *     signature)` is unaffected by deleting older rows).
 *   - A forward-walking verifier (POST /api/activity/export) starts at
 *     the oldest *surviving* row. That row's `prevSignatureHash` now
 *     references a purged row, so the verifier simply treats it as the
 *     new history origin ("history begins here") — exactly how it treats
 *     the genesis row. Truncating from the tail of history is detectable
 *     and safe; deleting from the MIDDLE would break the chain and is
 *     never done here.
 * Because deletion is strictly time-ordered (oldest first) and
 * ActivityRow `at` is monotonic with `id` in normal operation, the
 * surviving set is always a suffix of the chain — integrity preserved.
 */
import type { PrismaClient } from "@prisma/client";

export interface AuditPurgeResult {
  activityDeleted: number;
  commandAuditDeleted: number;
  notificationDeleted: number;
  /** True when olderThanDays <= 0 — purge skipped, nothing deleted. */
  skipped: boolean;
}

export async function purgeAuditLogs(
  prisma: PrismaClient,
  olderThanDays: number,
): Promise<AuditPurgeResult> {
  // <= 0 is the explicit "keep forever" / disabled state. Delete
  // nothing rather than computing a cutoff in the future (which would
  // wipe the whole table) or in the past with a 0-day window.
  if (olderThanDays <= 0) {
    return {
      activityDeleted: 0,
      commandAuditDeleted: 0,
      notificationDeleted: 0,
      skipped: true,
    };
  }

  const cutoff = new Date(Date.now() - olderThanDays * 86400_000);

  // ActivityRow: seal-and-truncate the oldest prefix (`at < cutoff`).
  // See the chain-integrity note above — this preserves the hash chain
  // for every surviving row.
  const activity = await prisma.activityRow.deleteMany({
    where: { at: { lt: cutoff } },
  });
  const commandAudit = await prisma.commandAuditLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  const notification = await prisma.notificationLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  return {
    activityDeleted: activity.count,
    commandAuditDeleted: commandAudit.count,
    notificationDeleted: notification.count,
    skipped: false,
  };
}
