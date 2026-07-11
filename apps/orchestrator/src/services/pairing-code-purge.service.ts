/**
 * WARP-1202/WARP-1203 — PairingCode lifecycle sweep + retention purge.
 *
 * Two steps, both keyed on the explicit `status` enum (WARP-1202 — never on
 * `claimedBy` nullability or an expiresAt-only derivation):
 *
 *   1. Transition write (WARP-1202): every `active` row past its `expiresAt`
 *      deadline is stamped with the explicit `expired` status. Readers
 *      already reject an overdue row in real time (/pair/claim's conditional
 *      consume carries `expiresAt > now`), so this flip is bookkeeping, not
 *      enforcement — it keeps the persisted state truthful between reads.
 *      Unbatched on purpose: post-migration the flip set is bounded by the
 *      5/user/hour mint rate limit since the previous sweep (the WARP-1202
 *      migration backfill already stamped historical rows).
 *
 *   2. Retention purge (WARP-1203): terminal rows — claimed / expired /
 *      revoked — older than the retention window are deleted. Growth is
 *      bounded by the mint rate limit, but without a purge the table grows
 *      forever and 6-char code collision odds rise with it (the P2002 retry
 *      in /devices/pair absorbs a rare collision; the purge keeps collision
 *      probability flat). Retention keys on `createdAt`: a code's whole
 *      lifecycle fits inside its 10-minute TTL, so "created > retentionDays
 *      ago" ≡ "terminal and stale for ~retentionDays" for every terminal
 *      status (there is no claimedAt column). Default 7 days — the same
 *      forensic window as purgeScheduleEvents and purgeUpdateBackups in the
 *      same 03:00 cron.
 *
 * Deletes are batched + capped per run (same precedent as
 * pruneExpiredLoginStates / audit-retention-purge): this table accumulated
 * forever until WARP-1203 landed, so a long-lived box's first run can hold a
 * years-deep backlog; bounded batches keep the daily-purge handler well
 * inside its 60 s advisory-lock transaction and the backlog drains over
 * nights. Best-effort like its cron siblings: errors propagate naked to
 * cron-runtime's safeRun — a lost night is harmless, the next tick
 * re-sweeps, and claim-time enforcement never depends on this job.
 */
import type { PrismaClient } from "@prisma/client";

/** Terminal rows older than this are purged. Mirrors the 7-day forensic
 *  window of purgeScheduleEvents / purgeUpdateBackups in the same cron. */
export const PAIRING_CODE_RETENTION_DAYS = 7;

/** PairingCode statuses that can never become claimable again (safe to purge). */
export const TERMINAL_PAIRING_CODE_STATUSES = [
  "claimed",
  "expired",
  "revoked",
] as const;

/** Rows deleted per `deleteMany` statement; mirrors sso-login-state. */
const DEFAULT_PURGE_BATCH_SIZE = 5000;
/** Hard upper bound on rows removed per run; mirrors sso-login-state. */
const DEFAULT_PURGE_MAX_ROWS = 100_000;

export interface SweepPairingCodesOptions {
  /** Terminal rows created earlier than this many days ago are purged.
   *  Default {@link PAIRING_CODE_RETENTION_DAYS}. */
  retentionDays?: number;
  /** Rows deleted per `deleteMany` statement. Default 5000. */
  batchSize?: number;
  /** Hard upper bound on rows removed per run. Default 100_000. */
  maxRowsPerRun?: number;
  /** Injectable clock for deterministic tests. Default `new Date()`. */
  now?: Date;
}

export interface SweepPairingCodesResult {
  /** Overdue `active` rows stamped `expired` this run. */
  expired: number;
  /** Terminal rows past retention removed this run. */
  purged: number;
}

export async function sweepPairingCodes(
  prisma: PrismaClient,
  options: SweepPairingCodesOptions = {},
): Promise<SweepPairingCodesResult> {
  const retentionDays =
    options.retentionDays ?? PAIRING_CODE_RETENTION_DAYS;
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_PURGE_BATCH_SIZE);
  const maxRowsPerRun = Math.max(
    1,
    options.maxRowsPerRun ?? DEFAULT_PURGE_MAX_ROWS,
  );
  const now = options.now ?? new Date();

  // ── 1. active → expired transition write (WARP-1202) ──
  // Idempotent: a re-run matches zero rows. Runs BEFORE the purge selection
  // so an overdue active row already past retention is stamped and removed
  // in the same run.
  const flipped = await prisma.pairingCode.updateMany({
    where: { status: "active", expiresAt: { lt: now } },
    data: { status: "expired" },
  });

  // ── 2. Retention purge of terminal rows (WARP-1203) ──
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const where = {
    status: { in: [...TERMINAL_PAIRING_CODE_STATUSES] },
    createdAt: { lt: cutoff },
  };

  let purged = 0;
  while (purged < maxRowsPerRun) {
    const take = Math.min(batchSize, maxRowsPerRun - purged);
    const batch = await prisma.pairingCode.findMany({
      where,
      orderBy: { createdAt: "asc" },
      take,
      select: { id: true },
    });
    if (batch.length === 0) break;
    const { count } = await prisma.pairingCode.deleteMany({
      where: { id: { in: batch.map((r) => r.id) } },
    });
    purged += count;
    // Short batch means we've drained everything currently purgable — done.
    if (batch.length < take) break;
  }

  return { expired: flipped.count, purged };
}
