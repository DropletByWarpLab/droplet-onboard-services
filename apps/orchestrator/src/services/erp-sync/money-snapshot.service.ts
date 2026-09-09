/**
 * WARP-2751 (ADR-051) — the time axis for money.
 *
 * `land-money.ts` overwrites `amount`, `balance` and `vendorStatus` on
 * `ErpDocument` IN PLACE on every sync tick. At the shipped 15-minute cadence
 * that destroys yesterday ninety-six times a day, and no history table exists
 * anywhere in the product. Ageing, DSO drift, "our overdue balance has doubled
 * since June", "which customers slowed down" are not hard questions against
 * that schema — they are unanswerable ones, however good the model is.
 *
 * This writes one row per subject per DAY, append-only, keyed so the
 * 15-minute cadence is idempotent within the day.
 *
 * ── Two decisions that depart from the ticket, both forced ───────────────────
 *
 * 🔴 1. THE SNAPSHOT IS TAKEN AFTER THE WRITE, NOT BEFORE IT.
 *
 * The ticket says "written by the existing sync tick immediately before the
 * in-place `updateMany`", to capture the value before it is destroyed. That
 * produces MIS-DATED rows. Work it through: a document is worth 1000 on day 1;
 * on day 2 at 09:00 the vendor changes it to 500; the 09:15 tick fires. A
 * before-write snapshot stores 1000 stamped `capturedOn = day 2` — a value
 * that was never true on day 2. An after-write snapshot stores 500 for day 2,
 * and day 1's row was written on day 1 and is not touched. "What was it worth
 * on this date" only answers correctly the second way.
 *
 * 🔴 2. IT RUNS OUTSIDE THE LANDING TRANSACTION, WHICH IS NOT A PREFERENCE.
 *
 * The AC asks that a snapshot failure not fail the sync tick. Inside the
 * landing `$transaction` that is IMPOSSIBLE to honour with a try/catch: once a
 * statement errors, Postgres aborts the whole transaction and every subsequent
 * statement fails with "current transaction is aborted". Catching the error
 * would leave the landing rolled back anyway — the swallow would be a lie.
 * So the capture runs on the top-level client after the landing commits, where
 * a failure genuinely is containable, and `captureMoneySnapshots` never throws.
 *
 * ── Why one statement and not a batched Prisma loop ──────────────────────────
 *
 * The sibling retention service (`drift-record.service.ts`) batches through
 * Prisma, and that is right for a DELETE whose row count is unbounded. This is
 * an INSERT ... SELECT over a table the box already holds: one statement, one
 * round trip, bounded by the document count, and idempotent by the unique key.
 * A per-document upsert loop would be N round trips ninety-six times a day to
 * reach exactly the same rows. The cost is that a mock cannot prove much about
 * it, which is why the real assertions live in `money-snapshot.pg.test.ts`.
 */
import type { CronRuntime } from "../cron-runtime.service.js";

/** The subject vocabulary. A documented string rather than an enum: the next
 *  two subjects (`crm_deal`, `pipeline`) are not landed yet, and an enum whose
 *  members arrive one migration at a time buys nothing here. */
export const SUBJECT_ERP_DOCUMENT = "erp_document";

/** Rows removed per `DELETE` statement in the downsample. */
const DEFAULT_TRIM_BATCH_SIZE = 5000;
/** Hard upper bound per run; the remainder drains over subsequent nights.
 *  Mirrors `drift-record.service.ts`, and for the reason it documents: the
 *  cron handler runs inside a 60 s advisory-lock transaction and one
 *  unbounded DELETE over a months-deep backlog can blow that budget, raise
 *  P2028, roll back, and re-attempt the same oversized set every night. */
const DEFAULT_TRIM_MAX_ROWS = 100_000;

export const MONEY_SNAPSHOT_RETENTION_CRON = "45 3 * * *";
export const MONEY_SNAPSHOT_RETENTION_LOCK_KEY = "droplet:money-snapshot-retention";

/**
 * How many days of DAILY rows the downsample keeps, by default.
 *
 * 🔴 THE ONE PLACE THIS NUMBER LIVES. `config.ts` takes it as the zod default
 * for `DROPLET_MONEY_SNAPSHOT_DAILY_DAYS`, and any READER that has to sit
 * inside the daily-grain window imports it from here — `receivables-ageing.ts`
 * being the first. The alternative is what was there before: a `90` in the
 * config schema, a `90` in a detector's comment, and a `90` typed into that
 * detector's guard test, which compared one literal against another and so
 * could not fail. Beyond this horizon the tail survives only as one row per
 * month, so a reader that assumes daily grain past it is reading a series that
 * is no longer daily.
 */
export const MONEY_SNAPSHOT_DAILY_DAYS_DEFAULT = 90;

/** The raw seam. Narrow on purpose — it is also the mock's shape. */
export interface MoneySnapshotPrisma {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export interface CaptureResult {
  /** Rows inserted or refreshed. */
  readonly captured: number;
  /** Set when the capture failed. The tick continues either way. */
  readonly error: string | null;
}

export interface TrimResult {
  readonly deleted: number;
  readonly skipped: boolean;
}

/**
 * Upsert today's row for every money document.
 *
 * NEVER THROWS. A snapshot is observability, not the source of truth: losing a
 * day of history must not lose a day of landed invoices. The error is returned
 * for the caller to log — swallowed silently it would be the failure mode this
 * whole epic keeps rediscovering.
 *
 * `connectionId` narrows to one vendor for the per-tick call. Omit it for the
 * nightly sweep, which is the only path that reaches LOCAL documents — those
 * have no connection at all, so a tick-scoped capture alone would give a
 * business's own invoices no history.
 */
export async function captureMoneySnapshots(
  prisma: MoneySnapshotPrisma,
  args: { now: Date; connectionId?: string | null },
): Promise<CaptureResult> {
  const day = toUtcDateString(args.now);
  const connectionId = args.connectionId ?? null;

  try {
    // `status` takes whichever word the row actually has. The two columns are
    // MUTUALLY EXCLUSIVE by `ErpDocument_provenance` — a LANDED row carries the
    // vendor's prose in `vendorStatus` and NULL in `status`, a LOCAL row the
    // reverse — so COALESCE is exact here rather than a preference between two
    // populated values.
    const captured = await prisma.$executeRaw`
      INSERT INTO "MoneySnapshot" (
        "id", "capturedOn", "subjectType", "subjectId",
        "amount", "balance", "currency", "status", "createdAt"
      )
      SELECT
        -- ::text because the column is TEXT and Postgres will not implicitly
        -- cast a uuid into it.
        gen_random_uuid()::text,
        ${day}::date,
        -- Every bare parameter here needs its type stated. A placeholder in a
        -- SELECT list has no surrounding expression to infer from, and
        -- Postgres answers "could not determine data type of parameter"
        -- rather than guessing.
        ${SUBJECT_ERP_DOCUMENT}::text,
        d."id",
        d."amount",
        d."balance",
        d."currency",
        COALESCE(d."vendorStatus", d."status"::text),
        NOW()
      FROM "ErpDocument" d
      WHERE (${connectionId}::text IS NULL OR d."connectionId" = ${connectionId}::text)
      ON CONFLICT ("capturedOn", "subjectType", "subjectId") DO UPDATE SET
        "amount"   = EXCLUDED."amount",
        "balance"  = EXCLUDED."balance",
        "currency" = EXCLUDED."currency",
        "status"   = EXCLUDED."status"
    `;
    return { captured, error: null };
  } catch (err) {
    return { captured: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Downsample the tail: daily rows inside the window, one row per month beyond
 * it.
 *
 * A plain delete-older-than would answer the storage problem and destroy the
 * question the table exists for — "how has this looked over two years" needs
 * the old rows to be THINNER, not absent. Beyond the window this keeps the
 * LAST row of each month per subject (the month's closing value, matching the
 * daily rows' own last-write-wins semantics) and drops the rest.
 *
 * `dailyDays <= 0` is the EXPLICIT "keep every daily row forever" state, not a
 * sentinel guessed from a missing value — same posture as `purgeAuditLogs` and
 * `trimErpDriftRecords`, and it lets an operator turn the downsample off
 * without a code change.
 */
export async function trimMoneySnapshots(
  prisma: MoneySnapshotPrisma,
  dailyDays: number,
  now: Date = new Date(),
  opts: { batchSize?: number; maxRows?: number } = {},
): Promise<TrimResult> {
  if (!Number.isFinite(dailyDays) || dailyDays <= 0) {
    return { deleted: 0, skipped: true };
  }

  const batchSize = opts.batchSize ?? DEFAULT_TRIM_BATCH_SIZE;
  const maxRows = opts.maxRows ?? DEFAULT_TRIM_MAX_ROWS;
  const cutoff = toUtcDateString(new Date(now.getTime() - dailyDays * 24 * 60 * 60 * 1000));

  let deleted = 0;
  while (deleted < maxRows) {
    const take = Math.min(batchSize, maxRows - deleted);
    const count = await prisma.$executeRaw`
      DELETE FROM "MoneySnapshot" WHERE "id" IN (
        SELECT "id" FROM (
          SELECT
            "id",
            ROW_NUMBER() OVER (
              PARTITION BY "subjectType", "subjectId", date_trunc('month', "capturedOn")
              -- DESC: the survivor is the month's LAST row, which is the
              -- month's closing value. ASC would keep the opening one and
              -- silently shift every historical series by up to a month.
              ORDER BY "capturedOn" DESC
            ) AS rn
          FROM "MoneySnapshot"
          -- STRICTLY less than the cutoff: a row exactly on the boundary is
          -- inside the window and survives. An off-by-one here quietly
          -- shortens every operator's daily history by a day.
          WHERE "capturedOn" < ${cutoff}::date
        ) ranked
        WHERE ranked.rn > 1
        LIMIT ${take}
      )
    `;
    if (count === 0) break;
    deleted += count;
    // Fewer deleted than asked for means the tail is exhausted; stop rather
    // than spin on a set that cannot shrink further.
    if (count < take) break;
  }

  return { deleted, skipped: false };
}

/**
 * A function rather than four lines in `index.ts` so the REGISTRATION is
 * testable — the spec, the lock key and the window are contract, and a test
 * that can only reach the handler proves none of them. Scheduling goes through
 * `cron-runtime`; a `setInterval` here would skip the advisory lock and let a
 * multi-instance box downsample twice concurrently.
 *
 * 03:45 continues the 03:00 / 03:15 / 03:30 spacing that keeps the retention
 * legs off each other's lock pool.
 */
export function registerMoneySnapshotMaintenance(
  cronRuntime: Pick<CronRuntime, "scheduleCron">,
  prisma: MoneySnapshotPrisma,
  opts: {
    dailyDays: number;
    onRun?: (result: { capture: CaptureResult; trim: TrimResult }) => void;
    now?: () => Date;
  },
): void {
  cronRuntime.scheduleCron(
    MONEY_SNAPSHOT_RETENTION_CRON,
    async () => {
      const at = (opts.now ?? (() => new Date()))();
      // UNSCOPED, and this is the only path that reaches a LOCAL document: it
      // has no connection, so the per-tick capture — which is scoped to the
      // vendor that just landed — never sees one. Without this leg a
      // business's OWN invoices would have no history at all, which is the
      // half of the ledger WARP-2739 just made first-class.
      const capture = await captureMoneySnapshots(prisma, { now: at });
      // Capture BEFORE trim so today's row exists before the downsample runs,
      // and so a trim failure cannot cost a day of history.
      const trim = await trimMoneySnapshots(prisma, opts.dailyDays, at);
      opts.onRun?.({ capture, trim });
    },
    { lockKey: MONEY_SNAPSHOT_RETENTION_LOCK_KEY },
  );
}

/**
 * `YYYY-MM-DD` in UTC.
 *
 * UTC and not local time so the day a row lands on does not depend on which
 * timezone the container happens to boot in — a box moved from Los Angeles to
 * New York must not suddenly write two rows for one day, or none.
 */
export function toUtcDateString(at: Date): string {
  return at.toISOString().slice(0, 10);
}
