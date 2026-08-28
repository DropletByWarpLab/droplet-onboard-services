/**
 * WARP-2218 / ADR-041 — the first `ErpSyncCursor` writers in the tree.
 *
 * Before this module the model had ZERO writers: the only three references in
 * source were connector docstrings explaining why each track deliberately did
 * not become the first one. Becoming that writer is in scope for WARP-2218 and
 * only for cursors and watermarks — `ErpEntityCache` still has no writer, and
 * must not get one here. ADR-041 §4 forbids it until WARP-2028 lands the
 * encryption that model's schema already promises, so this module moves
 * POSITIONS, never records.
 *
 * Shaped after `m365/delta-cursor.service.ts`, which is the proven version of
 * the same lifecycle, with one deliberate difference: the claim here is a real
 * conditional update rather than a bare `findMany`. `claimDueCursors` reads
 * rows and leaves them claimable, which is safe only because the M365 engine
 * has a single caller; a cron-driven poller with an advisory lock that can be
 * skipped, plus a sweep on its own cadence, has two paths into the same row.
 *
 * Prisma is injected, so the whole lifecycle is testable without a database —
 * the team rule after the mock/prod divergence incident is that DB paths stay
 * stubbed with `vi.fn()` rather than run against a mock database.
 */
import {
  classifySyncFailure,
  computeBackoffMs,
  parseRetryAfter,
  type SyncFailureLike,
} from "../m365/sync-policy.js";
import { redactSyncErrorText } from "./redact.js";

/**
 * States the scheduler may pick up.
 *
 * Excludes two, for the same reasons `delta-cursor.service.ts` does:
 *   - `SYNCING`, so two ticks cannot overlap on one cursor and double-spend a
 *     metered vendor call.
 *   - `FAILED`, which means retrying will not help and a person needs to look.
 *     Retrying it every tick would hammer the vendor to no purpose.
 */
export const CLAIMABLE_ERP_SYNC_STATES = ["IDLE", "BACKOFF", "RESYNC_REQUIRED"] as const;

/**
 * Connection statuses whose cursors may be polled.
 *
 * `CONNECTED` is the happy path; `DEGRADED` is an explicitly transient sync
 * failure (schema.prisma:4306-4318) and is exactly the state a retry is
 * supposed to clear. Everything else is excluded on purpose:
 * `NOT_CONFIGURED` and `PROVISIONING` have no credential to spend,
 * `DISABLED` means an operator turned it off and polling it anyway would
 * ignore them, `DRIFT_LOCKED` froze the connection deliberately, and `ERROR`
 * needs a person.
 */
export const POLLABLE_CONNECTION_STATUSES = ["CONNECTED", "DEGRADED"] as const;

export type ErpSyncStateName =
  | "IDLE"
  | "SYNCING"
  | "BACKOFF"
  | "RESYNC_REQUIRED"
  | "FAILED";

/** A cursor the scheduler has exclusively claimed for this tick. */
export interface ClaimedErpCursor {
  id: string;
  connectionId: string;
  entity: string;
  /** Null means "enumerate from the beginning" — never synced, or resyncing. */
  watermark: string | null;
  /** The state the cursor held BEFORE the claim flipped it to SYNCING. */
  previousState: ErpSyncStateName;
  consecutiveFailures: number;
  lastSweepAt: Date | null;
}

/** The Prisma surface this module needs. Structural so tests stub it. */
export interface ErpCursorPrisma {
  integrationConnection: {
    findMany(args: unknown): Promise<Array<{ id: string; provider: string; status: string }>>;
  };
  erpSyncCursor: {
    findMany(args: unknown): Promise<Array<Record<string, unknown>>>;
    updateMany(args: unknown): Promise<{ count: number }>;
    update(args: unknown): Promise<unknown>;
    upsert(args: unknown): Promise<unknown>;
  };
}

/**
 * Claim the cursors this tick may run, exclusively.
 *
 * Two steps rather than one join, because `ErpSyncCursor.connectionId` is a
 * plain column with no Prisma relation — adding one would mean a foreign key
 * and a back-relation on `IntegrationConnection`, which is more schema churn
 * than this story owns. The status filter is therefore explicit and visible
 * here, which is also where a reviewer wants to see it.
 *
 * The claim itself is a CONDITIONAL `updateMany` keyed on the state we just
 * read. If another tick (or the sweep) claimed the row in between, the
 * predicate matches zero rows, `count` is 0, and this tick skips it. An
 * unconditional `update` would hand the same cursor to both callers and
 * double-spend a metered vendor call — which is the mutation this module's
 * exclusivity test is written against.
 */
export async function claimDueErpCursors(
  prisma: ErpCursorPrisma,
  limit: number,
  now: Date = new Date(),
): Promise<ClaimedErpCursor[]> {
  const pollable = await prisma.integrationConnection.findMany({
    where: { status: { in: [...POLLABLE_CONNECTION_STATUSES] } },
    select: { id: true, provider: true, status: true },
  });
  const pollableIds = pollable.map((c) => c.id);
  if (pollableIds.length === 0) return [];

  const candidates = await prisma.erpSyncCursor.findMany({
    where: {
      // The status filter. Dropping it polls a DISABLED or NOT_CONFIGURED
      // connection, which is the mutation the "never polls a disabled
      // connection" test is written against.
      connectionId: { in: pollableIds },
      state: { in: [...CLAIMABLE_ERP_SYNC_STATES] },
      // Never attempted, or its backoff window has elapsed.
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    take: limit,
  });

  // Snapshot every field BEFORE any write. The rows a driver hands back are
  // detached copies in production, but reading them lazily inside the loop
  // would make correctness depend on that — and the whole point of this loop
  // is that it is racing another one.
  const snapshots = candidates.map((row) => ({
    id: String(row.id),
    connectionId: String(row.connectionId),
    entity: String(row.entity),
    watermark: typeof row.watermark === "string" ? row.watermark : null,
    previousState: String(row.state) as ErpSyncStateName,
    consecutiveFailures: Number(row.consecutiveFailures ?? 0),
    lastSweepAt: (row.lastSweepAt as Date | null) ?? null,
  }));

  const claimed: ClaimedErpCursor[] = [];
  for (const snap of snapshots) {
    const { count } = await prisma.erpSyncCursor.updateMany({
      // The compare half of a compare-and-swap, and the reason this is an
      // `updateMany` rather than an `update`: only `updateMany` reports how
      // many rows the predicate actually matched.
      //
      // The predicate re-checks the CLAIMABLE SET rather than the exact state
      // read a moment ago. Both forms reject a row someone else already took,
      // but only this one rejects it when the read itself raced — a row that
      // has since flipped to SYNCING matches no claimable state, so a second
      // tick cannot re-claim a cursor that is mid-run under any interleaving.
      // Comparing to the read-time value instead lets exactly that through.
      //
      // Dropping this clause entirely makes the claim unconditional and hands
      // the same cursor to both ticks, which double-spends a metered vendor
      // call — the mutation the exclusivity test is written against.
      where: { id: snap.id, state: { in: [...CLAIMABLE_ERP_SYNC_STATES] } },
      data: { state: "SYNCING" },
    });
    if (count !== 1) continue; // someone else took it; not ours to run.
    claimed.push(snap);
  }
  return claimed;
}

/**
 * Every progress-bearing field of a cursor that has never run, with the
 * EXPLICIT value each one carries in that state.
 *
 * ONE definition, shared by the two writers that have to produce it: the
 * `create` half of `upsertErpCursor` (a cursor that has never existed) and
 * `resetCursorsForConnection` (a cursor whose history has been repudiated).
 * Two hand-written copies would agree on the day they were written and
 * diverge on the day a field is added — whoever adds it updates the writer
 * they happen to be thinking about, and the other silently starts leaving a
 * stale value behind. Shared, extending this object is the only way to extend
 * either writer.
 *
 * `state: "IDLE"` is the load-bearing member, and the reason a reset WRITES
 * this set rather than deleting the rows. Deleting them would make "this
 * connection is not syncing" something a later reader INFERS from absence,
 * which is exactly what the explicit-enum rule forbids — and `foldSyncState`
 * would then report `syncState: null`, "no cursor registered", a different
 * claim from "registered, idle, at position zero".
 */
export const UNSTARTED_ERP_CURSOR = {
  /** Null = enumerate from the beginning (schema.prisma:4486-4494). */
  watermark: null,
  state: "IDLE",
  consecutiveFailures: 0,
  nextAttemptAt: null,
  lastSyncedAt: null,
  lastSweepAt: null,
  needsReconnect: false,
  lastError: null,
} as const satisfies { state: ErpSyncStateName } & Record<string, unknown>;

/**
 * Register an entity this connection should track. Idempotent.
 *
 * Deliberately does NOT reset an existing cursor's watermark: registration
 * runs on every tick, and clobbering the position there would re-enumerate
 * the whole account each time — the same bug `upsertCursor` guards against on
 * the M365 side.
 */
export async function upsertErpCursor(
  prisma: ErpCursorPrisma,
  connectionId: string,
  entity: string,
): Promise<void> {
  await prisma.erpSyncCursor.upsert({
    where: { connectionId_entity: { connectionId, entity } },
    create: { connectionId, entity, ...UNSTARTED_ERP_CURSOR },
    // Touch nothing that carries progress. Re-registration is not news.
    update: {},
  });
}

/**
 * The Prisma surface a cursor RESET needs — deliberately narrower than
 * `ErpCursorPrisma`.
 *
 * The caller is `integrations.service.ts` `disconnect()`, which passes the
 * interactive transaction handle it is already holding. Demanding the full
 * scheduler surface there would force every integrations test stub to grow
 * `claimDueErpCursors`'s methods to satisfy a function that calls exactly one
 * of them. `ErpCursorPrisma` still satisfies this structurally, so the sync
 * side can pass its own client unchanged.
 */
export interface ErpCursorResetPrisma {
  erpSyncCursor: { updateMany(args: unknown): Promise<{ count: number }> };
}

/**
 * WARP-2482 — return every cursor of one connection to the unstarted state.
 *
 * ## The defect this closes
 *
 * `disconnect()` (WARP-2453) nulls the eight credential and identity columns
 * in the same `update` as `status: "DISABLED"`, and left `ErpSyncCursor`
 * entirely alone. Those rows outlive the credential that earned them, so
 * `foldSyncState` — which reads `state` and `needsReconnect` across a
 * connection's cursors — kept folding them into `detailFor()` and `list()`.
 * A connection whose credential had been revoked and then purged still
 * rendered `needsReconnect: true` / `syncState: "FAILED"` on the hub: the
 * dashboard asking an owner to re-authorize a connection nobody can
 * re-authorize, and reporting a sync failure for a sync that is not running.
 *
 * ## Why a reset and not a delete
 *
 * See `UNSTARTED_ERP_CURSOR`. Registration survives a disconnect; only
 * POSITION and HEALTH are repudiated. That also keeps this module inside
 * ADR-041 §4 — it still moves positions and never becomes `ErpEntityCache`'s
 * first writer.
 *
 * ## `ErpDriftRecord` is deliberately RETAINED, not reset
 *
 * The decision, so it is not left implicit. WARP-2463's drift rows for this
 * connection are NOT deleted here, for four reasons:
 *
 *  1. They are not credential material and not customer content. The model is
 *     counts and timestamps by construction (schema.prisma:4586-4598) — there
 *     is no column a record id, a name or an amount can reach — so ADR-041
 *     §2's purge mandate, which is about *stored tokens*, does not reach them.
 *  2. They cannot reproduce this defect. Nothing folds them into a connection
 *     summary: the only readers are `driftForConnection` (its own admin
 *     endpoint) and `cleanSweepStreak`. `detailFor()` and `list()` read
 *     `erpSyncCursor` and nothing else.
 *  3. What they answer outlives one credential. "Has the incremental path
 *     been trustworthy for this vendor" is a question about the VENDOR's API
 *     semantics — Xero's `UpdatedDateUTC` not moving on a DueDate change is
 *     true of Xero, not of the key we authenticated with. Deleting the
 *     evidence on disconnect would destroy it exactly when a reconnect is
 *     about to need it.
 *  4. Their lifetime already has an owner: the `sweepAt`-indexed retention
 *     trim (`trimErpDriftRecords`, `ERP_DRIFT_RETENTION_CRON`). A second,
 *     differently-shaped deletion trigger would make retention two rules that
 *     can disagree instead of one.
 *
 * The consequence, stated rather than discovered later: a `cleanSweepStreak`
 * earned before a disconnect carries across it, so the first sweep after a
 * reconnect can still run at a lengthened cadence. That is intended under (3)
 * — the streak measures the vendor, not the grant — and it is capped at
 * `MAX_SWEEP_INTERVAL_MULTIPLIER` either way. Revisit only if reconnecting a
 * connection to a *different* account at the same vendor becomes a real flow.
 *
 * Returns the number of cursors reset, so the caller can log a count without
 * a second read.
 */
export async function resetCursorsForConnection(
  tx: ErpCursorResetPrisma,
  connectionId: string,
): Promise<number> {
  const { count } = await tx.erpSyncCursor.updateMany({
    where: { connectionId },
    data: { ...UNSTARTED_ERP_CURSOR },
  });
  return count;
}

/**
 * A completed incremental run: store the new position and clear the streak.
 *
 * `watermark` is written verbatim. It is the vendor's own ordering token and
 * reconstructing it by hand changes what the next read asks for — a bug that
 * presents as missing data rather than as a malformed request.
 */
export async function releaseErpCursorSuccess(
  prisma: ErpCursorPrisma,
  cursorId: string,
  watermark: string | null,
  now: Date = new Date(),
  sweptAt?: Date,
): Promise<void> {
  await prisma.erpSyncCursor.update({
    where: { id: cursorId },
    data: {
      watermark,
      state: "IDLE",
      consecutiveFailures: 0,
      nextAttemptAt: null,
      lastSyncedAt: now,
      // A revoked grant that starts working again is no longer a reconnect
      // ask; leaving this latched would nag an owner who already fixed it.
      needsReconnect: false,
      lastError: null,
      ...(sweptAt ? { lastSweepAt: sweptAt } : {}),
    },
  });
}

/**
 * A failed run, routed by `classifySyncFailure` — one classification, not a
 * second copy of the decision table.
 *
 *   - **RESYNC_REQUIRED** — the vendor will not honour our position. Drop it
 *     and re-enumerate. A NORMAL transition: it does not count toward the
 *     streak and takes no backoff, because delaying it only leaves the data
 *     stale for longer. It must never surface as an error.
 *   - **AUTH** — the grant is dead. That is a property of the CONNECTION, not
 *     of this cursor, so the cursor parks in BACKOFF and **keeps its
 *     watermark** (discarding it would force a full re-enumeration once the
 *     owner reconnects), and `needsReconnect` is set so the hub can ask for a
 *     new credential. ADR-041 calls this routine; it is not an ERROR.
 *   - **TRANSIENT** — back off. `Retry-After` is obeyed exactly where the
 *     vendor sends one; HubSpot and Stripe both do, and retrying earlier than
 *     they asked deepens the throttling it is trying to escape.
 *   - **FATAL** — stop. Retrying a malformed request forever helps nobody.
 */
export async function releaseErpCursorFailure(
  prisma: ErpCursorPrisma,
  cursor: Pick<ClaimedErpCursor, "id" | "consecutiveFailures">,
  err: SyncFailureLike,
  retryAfterHeader?: string | null,
  now: Date = new Date(),
): Promise<ErpSyncStateName> {
  const kind = classifySyncFailure(err);

  if (kind === "RESYNC_REQUIRED") {
    await prisma.erpSyncCursor.update({
      where: { id: cursor.id },
      data: {
        state: "RESYNC_REQUIRED",
        // Keeping it would replay a position the vendor has already rejected.
        watermark: null,
        consecutiveFailures: 0,
        nextAttemptAt: null,
        needsReconnect: false,
        lastError: null,
      },
    });
    return "RESYNC_REQUIRED";
  }

  const failures = cursor.consecutiveFailures + 1;

  if (kind === "FATAL") {
    await prisma.erpSyncCursor.update({
      where: { id: cursor.id },
      data: {
        state: "FAILED",
        consecutiveFailures: failures,
        nextAttemptAt: null,
        needsReconnect: false,
        lastError: redactSyncErrorText(err),
      },
    });
    return "FAILED";
  }

  // TRANSIENT and AUTH both wait. They differ in one thing: AUTH also asks the
  // owner for a new credential, and keeps the watermark so reconnecting does
  // not cost a full re-enumeration.
  const waitMs = computeBackoffMs(failures, parseRetryAfter(retryAfterHeader, now));
  await prisma.erpSyncCursor.update({
    where: { id: cursor.id },
    data: {
      state: "BACKOFF",
      consecutiveFailures: failures,
      nextAttemptAt: new Date(now.getTime() + waitMs),
      needsReconnect: kind === "AUTH",
      lastError: redactSyncErrorText(err),
    },
  });
  return "BACKOFF";
}
