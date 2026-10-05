/**
 * WARP-541 — the single choke point for DeviceUpdate status writes.
 *
 * The DeviceUpdate table is the OTA audit trail: rows are append-only
 * (one per release, never deleted — the retention GC reaps backup FILES,
 * never rows) and the status column is an ADVANCE-ONLY state machine:
 *
 *   pending ──► superseded            (a newer release arrived)
 *   pending ──► verifying ──► applying ──► committed
 *                    │             ├─────► rolled_back
 *                    │             └─────► failed
 *                    ├───► rejected
 *                    └───► superseded  (WARP-3430: a PARKED row — retry_later —
 *                                       that a newer release overtook, or that
 *                                       went stale before it could apply)
 *
 * Before WARP-541 the callers (poller.ts supersede, apply.ts setStatus)
 * each did their own raw `update`/`updateMany` — every call site happened
 * to advance, but nothing ENFORCED it. Now every status write funnels
 * through this module, which:
 *   1. refuses any transition not in DEVICE_UPDATE_ALLOWED_TRANSITIONS
 *      (a backwards or terminal-escaping write throws — a genuine bug,
 *      surfaced loudly, never silently absorbed);
 *   2. makes the write CONDITIONAL on the observed `from` status
 *      (`updateMany` with `{ id, status: from }`), so a concurrent writer
 *      can never be silently clobbered — count 0 means the row moved
 *      under us and we throw instead of overwriting;
 *   3. emits one `update.status_transition` debug event per write, so the
 *      full audit trail is reconstructible from logs alone (WARP-541).
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type pino from "pino";
import { createLogger } from "../../lib/logger.js";

const defaultLog = createLogger("update-agent");

/** Both the root client and a $transaction client can write status. */
type Db = PrismaClient | Prisma.TransactionClient;

/**
 * WARP-3504 — one observer per consumer of status changes (the box telemetry
 * sender turns them into OTA events). Fired AFTER the guarded write landed,
 * with the row's release tag; an observer that throws is swallowed, so no
 * consumer can ever fail an update.
 */
export interface DeviceUpdateTransition {
  id: string;
  from: string;
  to: DeviceUpdateStatusName;
  failureReason: string | null;
  releaseTag: string | null;
}
const transitionObservers = new Set<(t: DeviceUpdateTransition) => void>();

/** Subscribe to every future guarded status write. Returns an unsubscribe. */
export function onDeviceUpdateTransition(observer: (t: DeviceUpdateTransition) => void): () => void {
  transitionObservers.add(observer);
  return () => {
    transitionObservers.delete(observer);
  };
}

export type DeviceUpdateStatusName =
  | "pending"
  | "superseded"
  | "verifying"
  | "applying"
  | "committed"
  | "rolled_back"
  | "failed"
  | "rejected";

/** WARP-3007 — mirrors schema.prisma DeviceUpdateOutcome. */
export type DeviceUpdateOutcomeName =
  | "not_applied"
  | "starting_services"
  | "committed"
  | "services_start_failed"
  | "rolled_back"
  | "rollback_failed";

/**
 * The advance-only map (mirrors the schema.prisma DeviceUpdateStatus
 * diagram, plus WARP-3430's `verifying → superseded`: a row parked by a
 * transient failure is retired, not applied, once it is no longer the release
 * this box should take). Terminal statuses map to [] — nothing ever leaves
 * them.
 */
export const DEVICE_UPDATE_ALLOWED_TRANSITIONS: Record<
  DeviceUpdateStatusName,
  readonly DeviceUpdateStatusName[]
> = {
  pending: ["superseded", "verifying"],
  verifying: ["applying", "rejected", "superseded"],
  applying: ["committed", "rolled_back", "failed"],
  superseded: [],
  committed: [],
  rolled_back: [],
  failed: [],
  rejected: [],
};

export class DeviceUpdateTransitionError extends Error {
  readonly deviceUpdateId: string;
  readonly from: string | null;
  readonly to: string;
  constructor(deviceUpdateId: string, from: string | null, to: string, reason: string) {
    super(
      `DeviceUpdate ${deviceUpdateId}: refusing status transition ` +
        `${from ?? "(no row)"} → ${to} — ${reason}`,
    );
    this.name = "DeviceUpdateTransitionError";
    this.deviceUpdateId = deviceUpdateId;
    this.from = from;
    this.to = to;
  }
}

/** Throws unless `from → to` is in the advance-only map. */
export function assertTransitionAllowed(
  deviceUpdateId: string,
  from: string,
  to: DeviceUpdateStatusName,
): void {
  const allowed = DEVICE_UPDATE_ALLOWED_TRANSITIONS[from as DeviceUpdateStatusName];
  if (allowed === undefined) {
    throw new DeviceUpdateTransitionError(
      deviceUpdateId,
      from,
      to,
      "current status is not a known DeviceUpdateStatus",
    );
  }
  if (!allowed.includes(to)) {
    throw new DeviceUpdateTransitionError(
      deviceUpdateId,
      from,
      to,
      "the DeviceUpdate state machine is advance-only",
    );
  }
}

/**
 * Advance ONE row `→ to`, guarded. `failureReason` follows the WARP-539
 * convention (null while healthy; a vocabulary string on the refusal /
 * rollback / failure verdicts).
 */
export async function transitionDeviceUpdate(
  db: Db,
  opts: {
    id: string;
    to: Exclude<DeviceUpdateStatusName, "pending">;
    failureReason?: string | null;
    /** WARP-3007 — written in the same guarded write as the status. */
    outcome?: DeviceUpdateOutcomeName;
    logger?: pino.Logger;
  },
): Promise<void> {
  const log = opts.logger ?? defaultLog;
  const row = await db.deviceUpdate.findFirst({
    where: { id: opts.id },
    select: { status: true, releaseTag: true },
  });
  if (!row) {
    throw new DeviceUpdateTransitionError(opts.id, null, opts.to, "no such row");
  }
  assertTransitionAllowed(opts.id, row.status, opts.to);

  // Conditional on the status we just observed: if another writer moved
  // the row between the read and this write, count is 0 and we refuse
  // rather than clobber (advisory locks make this near-impossible, but
  // the audit table gets the guarantee, not the assumption).
  const res = await db.deviceUpdate.updateMany({
    where: { id: opts.id, status: row.status },
    data: {
      status: opts.to,
      failureReason: opts.failureReason ?? null,
      ...(opts.outcome ? { outcome: opts.outcome } : {}),
    },
  });
  if (res.count !== 1) {
    throw new DeviceUpdateTransitionError(
      opts.id,
      row.status,
      opts.to,
      "row status changed concurrently",
    );
  }
  log.debug?.(
    {
      event: "update.status_transition",
      deviceUpdateId: opts.id,
      from: row.status,
      to: opts.to,
      failureReason: opts.failureReason ?? null,
    },
    "DeviceUpdate status advanced",
  );
  for (const observe of transitionObservers) {
    try {
      observe({
        id: opts.id,
        from: row.status,
        to: opts.to,
        failureReason: opts.failureReason ?? null,
        releaseTag: row.releaseTag,
      });
    } catch {
      // Observers are best-effort by contract.
    }
  }
}

/**
 * WARP-3007 — the post-commit outcome (the status is already final at
 * `committed`). Conditional on the row still being `committed`, so it can
 * never relabel another verdict. Returns whether a row was written.
 */
export async function recordCommittedOutcome(
  db: Db,
  opts: {
    id: string;
    outcome: "committed" | "services_start_failed";
    logger?: pino.Logger;
  },
): Promise<boolean> {
  const res = await db.deviceUpdate.updateMany({
    where: { id: opts.id, status: "committed" },
    data: { outcome: opts.outcome },
  });
  (opts.logger ?? defaultLog).debug?.(
    { event: "update.outcome_recorded", deviceUpdateId: opts.id, outcome: opts.outcome },
    "DeviceUpdate outcome recorded",
  );
  return res.count === 1;
}

/**
 * Flip every `pending` row to `superseded` (the poller's "a newer release
 * arrived" sweep). Advance-only BY CONSTRUCTION: the where clause only
 * matches `pending`, so no other status can ever be dragged sideways.
 * Returns the superseded count.
 */
export async function supersedePendingUpdates(
  db: Db,
  logger?: pino.Logger,
): Promise<number> {
  const log = logger ?? defaultLog;
  const res = await db.deviceUpdate.updateMany({
    where: { status: "pending" },
    data: { status: "superseded" },
  });
  if (res.count > 0) {
    log.debug?.(
      {
        event: "update.status_transition",
        from: "pending",
        to: "superseded",
        count: res.count,
      },
      "prior pending DeviceUpdate rows superseded",
    );
  }
  return res.count;
}

/**
 * WARP-3430 — the same sweep for PARKED rows. A `verifying` row is one an
 * apply started and could not finish (a transient fetch failure, a registry
 * that refused auth): it stays resumable, and every apply path picks the
 * newest `pending|verifying` row. Left alone, a parked row older than a newer
 * release would still be eligible — apply B, commit, and the next window
 * would apply A, a downgrade. So when a newer release arrives, retire them.
 *
 * Only `unclaimed` rows: a claimed row is mid-apply (WARP-3193 PERF-3) and
 * must not change status under its runner. Both predicates sit in ONE
 * `updateMany`, so a row a runner claims between our read and write is not
 * touched, and one we flip is no longer claimable (the claim's own WHERE
 * needs `pending|verifying`). Advance-only by construction, like the pending
 * sweep. Returns the retired count.
 */
export async function supersedeUnclaimedVerifyingUpdates(
  db: Db,
  logger?: pino.Logger,
): Promise<number> {
  const log = logger ?? defaultLog;
  const res = await db.deviceUpdate.updateMany({
    where: { status: "verifying", applyClaim: "unclaimed" },
    data: { status: "superseded" },
  });
  if (res.count > 0) {
    log.debug?.(
      {
        event: "update.status_transition",
        from: "verifying",
        to: "superseded",
        count: res.count,
      },
      "prior parked (verifying) DeviceUpdate rows superseded",
    );
  }
  return res.count;
}

/**
 * WARP-3430 — what this box is running, for the never-go-backwards floor: the
 * newest COMMITTED row's signed `builtAt` (the read health-monitor and
 * routes/updates.ts use for the box's version). Null when the box has never
 * committed an OTA release (a locally built one) — no floor. ONE query shared
 * by the poller (row creation) and apply (before any side effect), so the two
 * gates can never disagree about what "installed" means.
 */
export async function installedRelease(
  db: Db,
): Promise<{ builtAt: Date; gitSha: string } | null> {
  return db.deviceUpdate.findFirst({
    where: { status: "committed" },
    orderBy: { updatedAt: "desc" },
    select: { builtAt: true, gitSha: true },
  });
}
