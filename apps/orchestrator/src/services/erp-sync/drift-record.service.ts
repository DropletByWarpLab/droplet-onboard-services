/**
 * WARP-2463 / ADR-041 — persisting the reconciliation sweep's drift report.
 *
 * ## What was broken
 *
 * WARP-2218 shipped the sweep and the drift report it emits, and the report
 * went to a log line and an `ActivityRow` scope. **Nothing stored it as data.**
 * So the one question the sweep exists to answer — *has the incremental path
 * been trustworthy for this vendor, and is it getting better or worse* — had
 * no queryable answer. Log retention on the box is the only place it survived,
 * and the box's log retention is not designed as a data store.
 *
 * That matters for three reasons, in ascending order of cost:
 *
 *   forensics  when an owner reports "the assistant didn't know about an
 *              invoice", the drift record says whether the incremental path
 *              missed it and when the sweep caught it.
 *   cadence    the sweep is the EXPENSIVE half of sync. A connection whose
 *              drift report has been empty for a month can sweep less often;
 *              one that keeps catching misses cannot. Without stored drift the
 *              cadence is a guess forever.
 *   money      Xero's egress is metered per app and scales with units sold
 *              (WARP-2383: ~$2,676 AUD/mo for 200 orgs at a naive 15-minute
 *              cadence). Drift history is what JUSTIFIES lengthening it.
 *
 * ## Absence is never the signal
 *
 * A row is written for every entity of every sweep, INCLUDING a sweep that
 * found nothing. `classification = NONE` is a stored fact. This is the
 * repo's no-guessing-state rule applied to an event table rather than a status
 * column: "the sweep found nothing" and "the sweep never ran" are opposite
 * answers to the question this table exists for, and a table that only records
 * misses cannot tell them apart. It would also make the drift-free streak —
 * the thing the cadence is tuned from — unreadable, because an empty result
 * would mean both "perfect" and "never measured".
 *
 * ## Counts and timestamps, structurally
 *
 * There is no column here a record identifier, a customer name, an amount or
 * an email can reach. `watermarkAt` / `earliestMissedAt` are `DateTime`, and
 * the raw vendor marker is coerced by `watermark.ts`'s `isoInstant`
 * before it can get near them — a vendor whose ordering key IS the record id
 * (Stripe cursors are object ids) would otherwise write invoice numbers into
 * a column that looks like a timestamp. A diagnostics table full of invoice
 * numbers is a customer-content export wearing a different label.
 *
 * ## The boundary this module does NOT cross
 *
 * It stores COUNTS ABOUT records. It stores no record. `ErpEntityCache` still
 * has zero writers and must: ADR-041 §4 forbids becoming its first writer
 * until WARP-2028 lands the encryption that model's schema already promises.
 */
import type { CronRuntime } from "../cron-runtime.service.js";
import { type ErpEntityDrift } from "./reconcile.js";
import { isoInstant } from "./watermark.js";

/**
 * The `ErpDriftClassification` enum members, as a TypeScript union.
 *
 * Mirrored by hand rather than imported from `@prisma/client` for the same
 * reason `ErpSyncStateName` is in `cursor.service.ts`: the Prisma enum object
 * only exists once the client has been generated, and every consumer here is
 * unit-tested against a `vi.fn()` store with no generated client in play.
 */
export type ErpDriftClassificationName =
  | "NONE"
  | "MISSED_NEWER"
  | "WATERMARK_BEHIND"
  | "MISSED_NEWER_AND_WATERMARK_BEHIND";

/** The Prisma surface this module needs. Structural so tests stub it. */
export interface ErpDriftPrisma {
  erpDriftRecord: {
    create(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<Array<Record<string, unknown>>>;
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
}

/** The columns one sweep writes for one (connection, entity). */
export interface ErpDriftRow {
  connectionId: string;
  provider: string;
  entity: string;
  sweepAt: Date;
  classification: ErpDriftClassificationName;
  missedCount: number;
  fullCount: number;
  incrementalCount: number;
  watermarkAt: Date | null;
  earliestMissedAt: Date | null;
}

/**
 * Fold `reconcile.ts`'s two independent drift classes onto the stored enum.
 *
 * Both classes can fire on the same pass, and the model stores ONE row per
 * (connection, entity) per sweep, so the co-occurrence needs its own member.
 * Collapsing it onto either half would misreport the diagnosis — and the
 * diagnosis is the entire product of this table: `missed-newer` says the
 * vendor's filter lied about a specific record (HubSpot / Stripe), while
 * `watermark-behind` says our position is trailing the account (Xero). The
 * remedies differ, so a reader that cannot tell "both" from "one" is being
 * given the wrong instruction half the time.
 */
export function classifyEntityDrift(drift: ErpEntityDrift): ErpDriftClassificationName {
  const missed = drift.classes.includes("missed-newer");
  const behind = drift.classes.includes("watermark-behind");
  if (missed && behind) return "MISSED_NEWER_AND_WATERMARK_BEHIND";
  if (missed) return "MISSED_NEWER";
  if (behind) return "WATERMARK_BEHIND";
  return "NONE";
}

/**
 * Project one entity's drift onto the row that gets stored.
 *
 * `watermark` is the vendor's raw ordering token off the cursor, and it goes
 * through `isoInstant` on the way in for the reason the module docstring
 * gives. It is the last place a raw marker exists in this path.
 */
export function driftRowFor(input: {
  connectionId: string;
  provider: string;
  sweepAt: Date;
  watermark: string | null;
  drift: ErpEntityDrift;
}): ErpDriftRow {
  const { connectionId, provider, sweepAt, watermark, drift } = input;
  return {
    connectionId,
    provider,
    entity: drift.entity,
    sweepAt,
    classification: classifyEntityDrift(drift),
    missedCount: drift.missedCount,
    fullCount: drift.fullCount,
    incrementalCount: drift.incrementalCount,
    watermarkAt: isoInstant(watermark),
    earliestMissedAt: drift.earliestMissedAt,
  };
}

/**
 * Write one sweep's finding for one (connection, entity).
 *
 * Unconditional. There is deliberately no `if (missedCount > 0)` here — see
 * the module docstring: skipping the clean write is the mutation that makes
 * this table unable to answer its own question.
 *
 * Errors are NOT swallowed. A drift record that silently fails to write
 * recreates exactly the gap this story closes, and `cron-runtime`'s `safeRun`
 * already turns a throw into a logged failure with a consecutive-failure
 * canary attached.
 */
export async function recordEntityDrift(
  prisma: ErpDriftPrisma,
  input: {
    connectionId: string;
    provider: string;
    sweepAt: Date;
    watermark: string | null;
    drift: ErpEntityDrift;
  },
): Promise<ErpDriftRow> {
  const row = driftRowFor(input);
  await prisma.erpDriftRecord.create({ data: row });
  return row;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Rows deleted per `deleteMany` statement. */
const DEFAULT_TRIM_BATCH_SIZE = 5000;
/** Hard upper bound on rows removed per run. */
const DEFAULT_TRIM_MAX_ROWS = 100_000;

export interface ErpDriftTrimResult {
  deleted: number;
  /** True when `olderThanDays <= 0` — retention disabled, nothing deleted. */
  skipped: boolean;
}

/**
 * Trim drift records older than the retention window.
 *
 * `olderThanDays <= 0` is the EXPLICIT "keep forever" state, not a sentinel
 * guessed from a missing value — same posture as `purgeAuditLogs`. It lets an
 * operator turn retention off without a code change.
 *
 * Batched and capped per run for the reason `audit-retention-purge.service.ts`
 * documents at length: a cron handler runs inside a 60 s advisory-lock
 * `$transaction`, and one unbounded `deleteMany` over a months-deep backlog
 * can blow that budget, raise P2028, roll back, and then re-attempt the same
 * oversized set every night forever. A capped batch loop has a hard per-run
 * upper bound by construction; the remainder drains over subsequent nights.
 *
 * This table is NOT hash-chained — unlike `ActivityRow` it has no
 * `prevSignatureHash` continuity to preserve — so a plain `sweepAt`-filtered
 * delete is correct here and the id-contiguous prefix dance does not apply.
 */
export async function trimErpDriftRecords(
  prisma: ErpDriftPrisma,
  olderThanDays: number,
  now: Date = new Date(),
  opts: { batchSize?: number; maxRows?: number } = {},
): Promise<ErpDriftTrimResult> {
  if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
    return { deleted: 0, skipped: true };
  }

  const batchSize = opts.batchSize ?? DEFAULT_TRIM_BATCH_SIZE;
  const maxRows = opts.maxRows ?? DEFAULT_TRIM_MAX_ROWS;
  const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000);

  let deleted = 0;
  while (deleted < maxRows) {
    const ids = (
      await prisma.erpDriftRecord.findMany({
        // STRICTLY less than the cutoff. A row exactly at the boundary is
        // inside the window and survives — an off-by-one here silently
        // shortens every operator's retention by a day.
        where: { sweepAt: { lt: cutoff } },
        select: { id: true },
        orderBy: { sweepAt: "asc" },
        take: Math.min(batchSize, maxRows - deleted),
      })
    ).map((r) => String(r.id));
    if (ids.length === 0) break;

    const res = await prisma.erpDriftRecord.deleteMany({ where: { id: { in: ids } } });
    deleted += res.count;
    // A driver that reports fewer deletes than ids selected means someone else
    // is deleting too; stop rather than spin.
    if (res.count < ids.length) break;
  }

  return { deleted, skipped: false };
}

/**
 * Cron spec for the retention trim.
 *
 * 03:30, deliberately its own leg rather than a line inside the 03:00
 * `droplet:daily-purge` handler. That handler already runs every retention
 * sweep on the box INSIDE one 60 s advisory-lock `$transaction`, and its own
 * docstring is largely an argument about staying under that budget; adding a
 * table to it spends from the same 60 s. A separate leg with its own lock key
 * has an independent budget, and 03:30 continues the existing 03:00 / 03:15
 * spacing that keeps the legs off each other's advisory-lock pool.
 */
export const ERP_DRIFT_RETENTION_CRON = "30 3 * * *";
export const ERP_DRIFT_RETENTION_LOCK_KEY = "droplet:erp-drift-retention";

/**
 * Register the retention trim on `cron-runtime`.
 *
 * A function rather than four lines in `index.ts` so the REGISTRATION itself
 * is testable — the spec, the lock key and the window are contract, and a test
 * that can only reach the handler cannot prove any of them. Scheduling in this
 * repo goes through `cron-runtime`; a `while (true)` poller here would be a
 * hard-rule violation, and a `setInterval` of its own would skip the advisory
 * lock and let a multi-instance box run the trim twice.
 */
export function registerErpDriftRetention(
  cronRuntime: Pick<CronRuntime, "scheduleCron">,
  prisma: ErpDriftPrisma,
  opts: {
    retentionDays: number;
    onTrimmed?: (result: ErpDriftTrimResult) => void;
    now?: () => Date;
  },
): void {
  cronRuntime.scheduleCron(
    ERP_DRIFT_RETENTION_CRON,
    async () => {
      const result = await trimErpDriftRecords(
        prisma,
        opts.retentionDays,
        (opts.now ?? (() => new Date()))(),
      );
      opts.onTrimmed?.(result);
    },
    { lockKey: ERP_DRIFT_RETENTION_LOCK_KEY },
  );
}

// ---------------------------------------------------------------------------
// The cadence hook — "drift-free sweeps in a row"
// ---------------------------------------------------------------------------

/** How many consecutive clean sweeps buy one doubling of the interval. */
export const CLEAN_SWEEPS_PER_STEP = 3;
/**
 * Ceiling on the multiplier.
 *
 * 8x a 24 h base is 8 days. Past that the sweep stops being a reconciliation
 * and becomes an audit: a vendor that starts dropping records would go
 * unnoticed for over a week, which is longer than the incremental path's own
 * failure would take to notice. The cap is the point where "cheaper" stops
 * being the dominant consideration.
 */
export const MAX_SWEEP_INTERVAL_MULTIPLIER = 8;

/** How many rows the streak walk reads. */
const DEFAULT_STREAK_ROW_LIMIT = 200;

/**
 * How many of the most recent sweeps for this connection were fully clean.
 *
 * A SWEEP is clean when every row it wrote is `NONE` — drift on any entity
 * means the incremental path was untrustworthy for that connection on that
 * pass, and lengthening the cadence because the other entity was fine would be
 * reading the evidence backwards.
 *
 * Derived from the stored enum rows rather than kept as a counter column, and
 * that is deliberate: a counter is a second copy of the truth that can drift
 * from the rows it summarises (and this story exists BECAUSE a summary with no
 * rows behind it was useless). Recomputing is self-healing — delete a row,
 * correct a row, and the streak follows. This does not violate the
 * no-guessing-state rule: the streak is an aggregate over EXPLICIT enum
 * values, never an inference from a null or an absent row.
 */
export async function cleanSweepStreak(
  prisma: ErpDriftPrisma,
  connectionId: string,
  opts: { rowLimit?: number } = {},
): Promise<number> {
  const rowLimit = opts.rowLimit ?? DEFAULT_STREAK_ROW_LIMIT;
  const rows = await prisma.erpDriftRecord.findMany({
    where: { connectionId },
    orderBy: { sweepAt: "desc" },
    take: rowLimit,
  });
  if (rows.length === 0) return 0;

  // Group consecutive rows by sweep instant, newest first. Every row one sweep
  // wrote carries the same `sweepAt`, which is what makes "was that whole
  // sweep clean" answerable at all.
  const sweeps: Array<{ key: number; clean: boolean }> = [];
  for (const row of rows) {
    const at = row.sweepAt as Date | undefined;
    const key = at instanceof Date ? at.getTime() : Number(at);
    const clean = String(row.classification) === "NONE";
    const last = sweeps[sweeps.length - 1];
    if (last && last.key === key) last.clean = last.clean && clean;
    else sweeps.push({ key, clean });
  }

  // The oldest group may be TRUNCATED by `take` — we could be holding only the
  // clean half of a sweep whose other rows drifted. Counting it would inflate
  // the streak and lengthen the cadence on evidence we did not actually read.
  if (rows.length >= rowLimit && sweeps.length > 0) sweeps.pop();

  let streak = 0;
  for (const sweep of sweeps) {
    if (!sweep.clean) break; // a miss RESETS; it does not merely pause.
    streak += 1;
  }
  return streak;
}

/**
 * The sweep interval this connection has earned.
 *
 * Doubles every `CLEAN_SWEEPS_PER_STEP` consecutive clean sweeps, capped. A
 * single drifted sweep drops the streak to 0 and the interval straight back to
 * base — asymmetric on purpose. Lengthening is an economic optimisation and can
 * afford to be slow and evidence-hungry; shortening is a correctness response
 * to proof that the incremental path is dropping records, and easing back in
 * gradually would keep sweeping too rarely for exactly as long as it takes to
 * miss more.
 */
export function sweepIntervalMsFor(
  baseMs: number,
  cleanStreak: number,
  opts: { perStep?: number; maxMultiplier?: number } = {},
): number {
  const perStep = opts.perStep ?? CLEAN_SWEEPS_PER_STEP;
  const maxMultiplier = opts.maxMultiplier ?? MAX_SWEEP_INTERVAL_MULTIPLIER;
  if (cleanStreak <= 0 || perStep <= 0) return baseMs;
  const steps = Math.floor(cleanStreak / perStep);
  const multiplier = Math.min(2 ** steps, maxMultiplier);
  return baseMs * multiplier;
}

// ---------------------------------------------------------------------------
// The read model behind the admin endpoint
// ---------------------------------------------------------------------------

/** One stored sweep finding, as the API renders it. */
export interface ErpDriftEntry {
  entity: string;
  provider: string;
  sweepAt: string;
  classification: ErpDriftClassificationName;
  missedCount: number;
  fullCount: number;
  incrementalCount: number;
  watermarkAt: string | null;
  earliestMissedAt: string | null;
}

export interface ErpDriftWindow {
  connectionId: string;
  windowDays: number;
  /** Newest first. */
  entries: ErpDriftEntry[];
  summary: {
    /** Rows in the window. Zero means no sweep ran, NOT "no drift". */
    rowsRecorded: number;
    /** Rows whose classification is anything but NONE. */
    driftedRows: number;
    totalMissed: number;
    /** Consecutive clean sweeps, newest first — the cadence signal. */
    cleanSweepStreak: number;
  };
}

const ISO = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v == null ? null : String(v);

/**
 * Drift for one connection over a window.
 *
 * Returns an empty `entries` list with `rowsRecorded: 0` for a connection that
 * has never been swept, rather than 404 — "we have no evidence" is a real and
 * different answer from "no such connection", and the hub renders it as such.
 */
export async function driftForConnection(
  prisma: ErpDriftPrisma,
  connectionId: string,
  windowDays: number,
  now: Date = new Date(),
  opts: { rowLimit?: number } = {},
): Promise<ErpDriftWindow> {
  const rowLimit = opts.rowLimit ?? DEFAULT_STREAK_ROW_LIMIT;
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const rows = await prisma.erpDriftRecord.findMany({
    where: { connectionId, sweepAt: { gte: since } },
    orderBy: { sweepAt: "desc" },
    take: rowLimit,
  });

  const entries: ErpDriftEntry[] = rows.map((r) => ({
    entity: String(r.entity),
    provider: String(r.provider),
    sweepAt: ISO(r.sweepAt) ?? "",
    classification: String(r.classification) as ErpDriftClassificationName,
    missedCount: Number(r.missedCount ?? 0),
    fullCount: Number(r.fullCount ?? 0),
    incrementalCount: Number(r.incrementalCount ?? 0),
    watermarkAt: ISO(r.watermarkAt),
    earliestMissedAt: ISO(r.earliestMissedAt),
  }));

  return {
    connectionId,
    windowDays,
    entries,
    summary: {
      rowsRecorded: entries.length,
      driftedRows: entries.filter((e) => e.classification !== "NONE").length,
      totalMissed: entries.reduce((n, e) => n + e.missedCount, 0),
      cleanSweepStreak: await cleanSweepStreak(prisma, connectionId, opts),
    },
  };
}
