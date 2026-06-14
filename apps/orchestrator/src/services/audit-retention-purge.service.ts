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
 * ── Finding 2 (PR #623): bounded batched deletes, capped per run ──
 * The daily-purge cron handler runs INSIDE a single 60 s advisory-lock
 * `prisma.$transaction` (see cron-runtime.service.ts `withAdvisoryLock`,
 * `{ timeout: 60_000 }`). The transaction stays open for the whole
 * wall-clock of the handler. A first-run / long-idle box can accumulate
 * months of rows; a single unbounded `deleteMany` scanning that entire
 * backlog could push the handler past 60 s, raising P2028, rolling the
 * transaction back, and then RE-attempting the exact same oversized set
 * on the next nightly tick — a permanent nightly-purge failure loop.
 *
 * Fix: never issue one statement that scans the whole backlog, and never
 * let one run do unbounded work.
 *   - We delete in bounded batches (`BATCH_SIZE` rows per statement), so
 *     each individual `deleteMany` is short and index-bounded.
 *   - We cap total rows removed per table per run (`MAX_ROWS_PER_TABLE`),
 *     so even a months-deep first-run backlog completes well under 60 s.
 *     The remainder drains over subsequent nights — steady-state daily
 *     row volume is far below the cap, so the table reaches its retention
 *     window within a few nights and stays there.
 * This keeps everything inside the existing advisory-lock transaction
 * (mutual exclusion is untouched — we did NOT restructure the lock or
 * raise its timeout) while making it impossible for the backlog to wedge
 * the cron. Chosen over "raise the 60 s timeout" because a higher timeout
 * still holds the advisory-lock transaction open for minutes on a huge
 * backlog (blocking nothing today, but a latent foot-gun) and still has a
 * worst-case where a pathological backlog exceeds any fixed bound; a
 * capped batch loop has a hard per-run upper bound by construction.
 *
 * ── Finding 3 (PR #623): id-contiguous prefix purge for ActivityRow ──
 * ActivityRow is the hash-chained table: the chain is built in `id`
 * order, each row's `signature` covering its content + `prevSignatureHash`
 * (= hash of the prior row's signature). Its `at` column is
 * `@default(now())` with NO database ordering guarantee relative to `id`.
 * Under an NTP step / clock skew, a higher-`id` row can carry an earlier
 * `at` than a lower-`id` row. A naive `deleteMany({ where: { at: { lt:
 * cutoff } } })` would then delete that skewed high-`id` row while leaving
 * its lower-`id`, newer-`at` predecessor alive — punching a MID-CHAIN
 * hole and severing `prevSignatureHash` continuity for every surviving
 * row that referenced the deleted one.
 *
 * Fix: purge ActivityRow by a contiguous oldest-`id` PREFIX, never by
 * `at` directly. The truncation point is anchored on the FIRST ROW WE
 * MUST KEEP, not on the oldest row we may delete: we find
 * `firstSurvivorId` = the min `id` among rows with `at >= cutoff`
 * (`ORDER BY id ASC LIMIT 1`), then delete only `id < firstSurvivorId`.
 *
 * Anchoring on the first survivor — rather than on `max(id) where at <
 * cutoff` — is what makes this skew-safe. Under clock skew a row with a
 * HIGHER id than a survivor can have an older `at`; keying the boundary
 * off the oldest deletable `at` would sweep that high-id row in and
 * delete the lower-id survivor sitting before it, re-introducing the very
 * mid-chain hole we are trying to avoid. By deleting strictly everything
 * before the lowest-id survivor, every deleted row has a smaller id than
 * every survivor, so the survivors are always a contiguous suffix of the
 * chain — a seal-and-truncate, never a mid-chain delete.
 *
 * (Worked example, cutoff = 30 d, `at` non-monotonic with `id`:
 *   id1 @40d, id2 @35d, id3 @10d, id4 @50d(skew), id5 @5d.
 *  firstSurvivorId = min id with at>=cutoff = id3, so we delete id<3 =
 *  {1,2}. id4 — older by `at` than survivor id3 but with a higher id —
 *  is correctly KEPT; survivors {3,4,5} stay a contiguous suffix.)
 *
 * If every row is older than the cutoff there is no survivor; we then
 * fall back to the max id (`ORDER BY id DESC LIMIT 1` among `at < cutoff`)
 * and truncate the whole table prefix `id <= maxId`.
 *
 * Why a forward-walking verifier is fine after truncation: every
 * surviving row keeps its own columns untouched, so each self-verifies
 * (`signer.verify(content, prevSignatureHash, signature)` is unaffected
 * by deleting older rows). The oldest *surviving* row's
 * `prevSignatureHash` now references a purged row, so the verifier
 * (POST /api/activity/export) treats it as the new history origin —
 * exactly how it treats the genesis row.
 *
 * The two log tables (CommandAuditLog, NotificationLog) are NOT
 * hash-chained — their `id` is a random cuid, not an autoincrement, so an
 * id-contiguous prefix has no meaning. They stay `createdAt`-filtered
 * (still batched + capped for Finding 2).
 */
import type { PrismaClient } from "@prisma/client";

export interface AuditPurgeResult {
  activityDeleted: number;
  commandAuditDeleted: number;
  notificationDeleted: number;
  /** True when olderThanDays <= 0 — purge skipped, nothing deleted. */
  skipped: boolean;
}

export interface AuditPurgeOptions {
  /** Rows deleted per `deleteMany` statement. Default 5000. */
  batchSize?: number;
  /**
   * Hard upper bound on rows removed PER TABLE PER RUN. Bounds the
   * wall-clock of the run so the 60 s advisory-lock transaction can't
   * time out on a huge first-run backlog; the remainder drains on
   * subsequent nights. Default 100_000.
   */
  maxRowsPerTable?: number;
}

// Defaults sized for the box: at 5k rows/statement an index-bounded
// `DELETE … WHERE id IN (...)` is well under a second, and 100k rows/run
// is a generous ceiling that still completes far inside the 60 s window
// while draining a year-plus of typical activity volume in a couple of
// nights.
const DEFAULT_BATCH_SIZE = 5000;
const DEFAULT_MAX_ROWS_PER_TABLE = 100_000;

export async function purgeAuditLogs(
  prisma: PrismaClient,
  olderThanDays: number,
  options: AuditPurgeOptions = {},
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

  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const maxRowsPerTable = Math.max(
    1,
    options.maxRowsPerTable ?? DEFAULT_MAX_ROWS_PER_TABLE,
  );
  const cutoff = new Date(Date.now() - olderThanDays * 86400_000);

  const activityDeleted = await purgeActivityRowPrefix(
    prisma,
    cutoff,
    batchSize,
    maxRowsPerTable,
  );
  const commandAuditDeleted = await purgeLogTable(
    prisma.commandAuditLog,
    cutoff,
    batchSize,
    maxRowsPerTable,
  );
  const notificationDeleted = await purgeLogTable(
    prisma.notificationLog,
    cutoff,
    batchSize,
    maxRowsPerTable,
  );

  return {
    activityDeleted,
    commandAuditDeleted,
    notificationDeleted,
    skipped: false,
  };
}

/**
 * Finding 3: delete the contiguous oldest-`id` prefix of ActivityRow.
 *
 * 1. Boundary lookup, anchored on the first survivor:
 *    `firstSurvivorId` = min `id` whose `at >= cutoff` (ORDER BY id ASC
 *    LIMIT 1). Every row with `id < firstSurvivorId` is necessarily old
 *    (if it weren't, it'd be a smaller-id survivor, contradicting min) —
 *    so we delete strictly `id < firstSurvivorId`, which both respects
 *    the retention window AND keeps survivors a contiguous suffix even
 *    under clock skew.
 *    If there is NO survivor (every row older than cutoff) we instead
 *    truncate the whole prefix up to the max old id.
 * 2. Batch-delete the prefix in id-ordered chunks, bounded by `batchSize`
 *    per statement and `maxRowsPerTable` per run (Finding 2).
 */
async function purgeActivityRowPrefix(
  prisma: PrismaClient,
  cutoff: Date,
  batchSize: number,
  maxRowsPerTable: number,
): Promise<number> {
  // Boundary = the lowest-id row we must KEEP. Delete everything strictly
  // before it (`id < firstSurvivorId`) so the chain never loses a row
  // that sits between two survivors.
  const firstSurvivor = await prisma.activityRow.findFirst({
    where: { at: { gte: cutoff } },
    orderBy: { id: "asc" },
    select: { id: true },
  });

  // Build the id predicate for the contiguous oldest prefix.
  let idFilter: { lt: bigint } | { lte: bigint };
  if (firstSurvivor) {
    idFilter = { lt: firstSurvivor.id };
  } else {
    // No survivor: every row is older than the cutoff. Truncate the whole
    // prefix up to the oldest-by-id row that is actually old.
    const lastOld = await prisma.activityRow.findFirst({
      where: { at: { lt: cutoff } },
      orderBy: { id: "desc" },
      select: { id: true },
    });
    if (!lastOld) return 0; // empty table or nothing old → no-op
    idFilter = { lte: lastOld.id };
  }

  let deleted = 0;
  while (deleted < maxRowsPerTable) {
    const take = Math.min(batchSize, maxRowsPerTable - deleted);
    const batch = await prisma.activityRow.findMany({
      where: { id: idFilter },
      orderBy: { id: "asc" },
      take,
      select: { id: true },
    });
    if (batch.length === 0) break;
    const ids = batch.map((r) => r.id);
    const res = await prisma.activityRow.deleteMany({
      where: { id: { in: ids } },
    });
    deleted += res.count;
    // Short final batch means we've reached the boundary — done.
    if (batch.length < take) break;
  }
  return deleted;
}

/**
 * Batched + capped `createdAt < cutoff` purge for a non-chained log
 * table (CommandAuditLog / NotificationLog). Their cuid `id` is random,
 * so we select an oldest-first id batch, then delete that id set —
 * bounding each statement (Finding 2) without an id-prefix assumption
 * (which only the autoincrement-chained ActivityRow can make).
 */
async function purgeLogTable(
  delegate: {
    findMany(args: {
      where: { createdAt: { lt: Date } };
      orderBy: { createdAt: "asc" };
      take: number;
      select: { id: true };
    }): Promise<Array<{ id: string }>>;
    deleteMany(args: {
      where: { id: { in: string[] } };
    }): Promise<{ count: number }>;
  },
  cutoff: Date,
  batchSize: number,
  maxRowsPerTable: number,
): Promise<number> {
  let deleted = 0;
  while (deleted < maxRowsPerTable) {
    const take = Math.min(batchSize, maxRowsPerTable - deleted);
    const batch = await delegate.findMany({
      where: { createdAt: { lt: cutoff } },
      orderBy: { createdAt: "asc" },
      take,
      select: { id: true },
    });
    if (batch.length === 0) break;
    const ids = batch.map((r) => r.id);
    const res = await delegate.deleteMany({ where: { id: { in: ids } } });
    deleted += res.count;
    if (batch.length < take) break;
  }
  return deleted;
}
