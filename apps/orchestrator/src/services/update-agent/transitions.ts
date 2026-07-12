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
 *                    └───► rejected
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

export type DeviceUpdateStatusName =
  | "pending"
  | "superseded"
  | "verifying"
  | "applying"
  | "committed"
  | "rolled_back"
  | "failed"
  | "rejected";

/**
 * The advance-only map (mirrors the schema.prisma DeviceUpdateStatus
 * diagram). Terminal statuses map to [] — nothing ever leaves them.
 */
export const DEVICE_UPDATE_ALLOWED_TRANSITIONS: Record<
  DeviceUpdateStatusName,
  readonly DeviceUpdateStatusName[]
> = {
  pending: ["superseded", "verifying"],
  verifying: ["applying", "rejected"],
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
    logger?: pino.Logger;
  },
): Promise<void> {
  const log = opts.logger ?? defaultLog;
  const row = await db.deviceUpdate.findFirst({
    where: { id: opts.id },
    select: { status: true },
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
    data: { status: opts.to, failureReason: opts.failureReason ?? null },
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
