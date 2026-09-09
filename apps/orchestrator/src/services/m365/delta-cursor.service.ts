/**
 * WARP-2118 / ADR-041 — delta-cursor lifecycle for the Microsoft 365 sync
 * engine.
 *
 * One cursor per (person, workload, resource). The grain matters: **mail delta
 * is a per-folder operation**, so a mailbox with ten folders has ten cursors.
 * Treating a mailbox as one cursor either loses changes or re-downloads
 * everything on each tick.
 *
 * This module owns the recovery behaviour — what a cursor does after a
 * success, a throttle, a dead delta token, and a dead grant. `sync-policy.ts`
 * makes the decisions; this applies them to state. Prisma is injected, so the
 * whole lifecycle is testable without a database.
 */
import type { PrismaClient } from "@prisma/client";

import {
  classifySyncFailure,
  computeBackoffMs,
  parseRetryAfter,
  type SyncFailureLike,
} from "./sync-policy.js";
import { redactDeltaTokens } from "./graph-resources.js";
import { redactAuthError } from "./state.js";

/** States the scheduler is allowed to pick up. */
const CLAIMABLE_STATES = ["IDLE", "BACKOFF", "RESYNC_REQUIRED"] as const;

export interface DueCursor {
  id: string;
  userId: string;
  workload: string;
  resourceId: string;
  /** Null means "enumerate from scratch" — either never synced, or resyncing. */
  deltaLink: string | null;
  state: string;
}

/**
 * The cursors the scheduler may run right now.
 *
 * Deliberately excludes two states:
 *   - `SYNCING`, so two ticks cannot overlap on one cursor and double-write.
 *   - `FAILED`, which means retrying will not help and a person needs to look.
 *     Retrying it on every tick would hammer Microsoft to no purpose.
 */
export async function claimDueCursors(
  prisma: PrismaClient,
  limit: number,
  now: Date = new Date(),
): Promise<DueCursor[]> {
  const rows = await prisma.m365DeltaCursor.findMany({
    where: {
      state: { in: [...CLAIMABLE_STATES] },
      // Never attempted, or its backoff window has elapsed.
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    take: limit,
  });

  return rows as unknown as DueCursor[];
}

/**
 * Register a resource the engine should track.
 *
 * Idempotent, and specifically **must not reset an existing cursor's delta
 * link**: folder discovery runs on every tick, and clobbering the link there
 * would re-download the whole mailbox each time.
 */
export async function upsertCursor(
  prisma: PrismaClient,
  userId: string,
  workload: string,
  resourceId: string,
): Promise<void> {
  await prisma.m365DeltaCursor.upsert({
    where: { userId_workload_resourceId: { userId, workload, resourceId } },
    create: {
      userId,
      workload,
      resourceId,
      deltaLink: null,
      state: "IDLE",
      consecutiveFailures: 0,
      nextAttemptAt: null,
      lastSyncedAt: null,
      lastError: null,
    },
    // Touch nothing that carries progress. Re-discovery is not new information.
    update: {},
  });
}

/**
 * A completed run: store the fresh delta link and clear the failure streak.
 *
 * The link is stored **verbatim**. It encodes `$select` and other request
 * state, so rebuilding it changes what the next sync asks Microsoft for — and
 * that presents as missing data, not as a malformed request.
 */
export async function recordSuccess(
  prisma: PrismaClient,
  cursorId: string,
  deltaLink: string | null,
  now: Date = new Date(),
): Promise<void> {
  await prisma.m365DeltaCursor.update({
    where: { id: cursorId },
    data: {
      deltaLink,
      state: "IDLE",
      consecutiveFailures: 0,
      nextAttemptAt: null,
      lastSyncedAt: now,
      lastError: null,
    },
  });
}

/**
 * A failed run, routed by what actually went wrong.
 *
 *   - **RESYNC_REQUIRED** (410 Gone / `syncStateNotFound`) — the delta token
 *     is dead. Drop it and re-enumerate. This is a normal transition, not a
 *     failure: it does not count toward the streak and is not delayed by
 *     backoff, because delaying it just leaves the person's data stale.
 *   - **TRANSIENT** — back off. `Retry-After` is obeyed exactly where present;
 *     throttled requests still count against the tenant's budget, so retrying
 *     early deepens the throttling.
 *   - **AUTH** — the grant is dead, which is a property of the CONNECTION, not
 *     this cursor. Park the cursor but **keep its delta link**: discarding it
 *     would force a full re-download once the person reconnects. This
 *     function does NOT touch the connection row: the auth service moves it
 *     to NEEDS_RECONNECT when a refresh fails, and the sync service does the
 *     same (`markNeedsReconnect`) when Graph answers a live call with 401/403
 *     — the case a refresh never sees.
 *   - **FATAL** — stop. Retrying a malformed request forever helps nobody.
 */
export async function recordFailure(
  prisma: PrismaClient,
  cursorId: string,
  err: SyncFailureLike,
  retryAfterHeader?: string | null,
  now: Date = new Date(),
): Promise<void> {
  const kind = classifySyncFailure(err);

  if (kind === "RESYNC_REQUIRED") {
    await prisma.m365DeltaCursor.update({
      where: { id: cursorId },
      data: {
        state: "RESYNC_REQUIRED",
        // Keeping the link would replay a token Graph has already rejected.
        deltaLink: null,
        consecutiveFailures: 0,
        nextAttemptAt: null,
        lastError: null,
      },
    });
    return;
  }

  const current = (await prisma.m365DeltaCursor.findMany({
    where: { id: cursorId } as never,
    take: 1,
  })) as unknown as Array<{ consecutiveFailures: number }>;
  const failures = (current[0]?.consecutiveFailures ?? 0) + 1;

  if (kind === "FATAL") {
    await prisma.m365DeltaCursor.update({
      where: { id: cursorId },
      data: {
        state: "FAILED",
        consecutiveFailures: failures,
        nextAttemptAt: null,
        lastError: redactSyncError(err),
      },
    });
    return;
  }

  // TRANSIENT and AUTH both wait. AUTH keeps its delta link deliberately.
  const waitMs = computeBackoffMs(failures, parseRetryAfter(retryAfterHeader, now));
  await prisma.m365DeltaCursor.update({
    where: { id: cursorId },
    data: {
      state: "BACKOFF",
      consecutiveFailures: failures,
      nextAttemptAt: new Date(now.getTime() + waitMs),
      lastError: redactSyncError(err),
    },
  });
}

/**
 * Make a sync failure safe to persist and render.
 *
 * Reuses the connector's credential redaction, then strips delta tokens
 * specifically: a delta link is a URL, so it reads as harmless, but it carries
 * a token of its own and must not land in a field the dashboard shows.
 *
 * BOTH passes are required; neither is a superset of the other (WARP-2118).
 *   - redactDeltaTokens() anchors on `?`/`&`, so it catches driveItem's bare
 *     `token=` form that the local pattern below cannot see — the gap it was
 *     written for.
 *   - the local pattern takes `$deltatoken=`/`$skiptoken=` with NO `?`/`&`
 *     before them, which a bare cursor value spliced into a message has.
 * Collapsing this to redactDeltaTokens() alone re-opens the second case, so
 * do not "simplify" it to one call without a test for a bare `$deltatoken=`.
 */
function redactSyncError(err: SyncFailureLike): string {
  const base = redactAuthError({
    errorCode: err.code,
    errorMessage: err.message,
    statusCode: err.statusCode,
  });
  return redactDeltaTokens(base).replace(
    /\$(delta|skip)token=\S+/gi,
    "$$$1token=[redacted]",
  );
}
