/**
 * PmActivity outbox consumer framework — ADR-069 §7.
 *
 * Every PM mutation already writes `PmActivity` inside its own transaction
 * (`writeActivity` in pm.service.ts), and the assignee notification sweep
 * already tails it. A row therefore exists if and only if its change
 * committed: the table IS a transactional outbox. Consumers read it through
 * this module instead of adding emit calls throughout the service.
 *
 * ── The contract ───────────────────────────────────────────────────────────
 *
 *   • Each consumer has its own cursor, a `(createdAt, id)` pair stored in
 *     `SystemFlag` under `pm-outbox:<consumer>` — the existing key/value table,
 *     no new model. `readOutboxBatch` returns the rows after it in that order;
 *     `advanceOutboxCursor` moves it.
 *   • A brand-new consumer starts at "now" and never replays history.
 *   • `registerOutboxConsumer` schedules a `cron-runtime` interval under its
 *     own Postgres advisory-lock key, so only one replica sweeps, and runs once
 *     at registration. `nudgeOutbox()` — which `writeActivity` calls — wakes the
 *     consumers early instead of making a write wait out the interval.
 *   • DELIVERY IS AT-LEAST-ONCE. The cursor moves after the handler returns, so
 *     a crash between the two replays the row. Every handler must be
 *     idempotent; a deterministic key on whatever it creates is the way.
 *   • Handlers run one row at a time, oldest first, and a failure stops the
 *     sweep at that row (the cursor stays before it) and is rethrown, so
 *     `cron-runtime` logs it and counts it. Order is preserved by refusing to
 *     skip ahead.
 *
 * ── Why a settle window, not just a cursor ─────────────────────────────────
 *
 * `(createdAt, id)` is a total order, but `createdAt` is stamped when the
 * INSERT is issued, not when its transaction commits. Take two writers:
 * transaction A inserts at 12:00:00.000 and is slow; transaction B inserts at
 * 12:00:00.500 and commits at once. A reader that runs at 12:00:00.600 sees B,
 * moves its cursor to 12:00:00.500, and when A finally commits its row is
 * BEHIND the cursor — skipped forever. That is the gap that would make the
 * ADR's "no consumer can miss an event that committed" untrue.
 *
 * The fix is to read only rows that have been still for `settleMs`. Prisma
 * interactive transactions time out after 5 s by default, and no PM write path
 * overrides it, so a row's commit lands at most 5 s after its `createdAt`;
 * 6 s (`DEFAULT_OUTBOX_SETTLE_MS`) leaves a second of margin. A writer that
 * raises its transaction timeout above that must raise this too. The cost is
 * stated rather than hidden: an event reaches a default consumer ~6 s after the
 * commit. A consumer whose events are advisory may pass a smaller `settleMs`
 * and accept a rare missed nudge; consumers that act on events keep the default.
 *
 * Postgres can hand out row ids in any order inside one millisecond (they are
 * UUIDs, and `createMany` stamps every row with one timestamp), which is why
 * `id` is part of the cursor and the comparison is `(createdAt, id) >` rather
 * than `createdAt >`.
 *
 * ── A row that never succeeds ──────────────────────────────────────────────
 *
 * Stopping at a failing row keeps order, but a row that can never succeed (a
 * handler bug on odd data) would then block every event behind it. A row that
 * has failed at least three times over `poisonAfterMs` (five minutes) is
 * dead-lettered: logged at error with its id, verb and work item, and skipped.
 * The window is what separates poison from a database restart, which fails
 * every row for seconds and must not lose any.
 *
 * Importing this module starts nothing (WARP-3193 QUAL-7): timers exist only
 * after `registerOutboxConsumer`, and `nudgeOutbox` is free until then.
 */
import type { PmActivity, PrismaClient } from "@prisma/client";
import type { CronJobHandle, CronRuntime } from "../cron-runtime.service.js";
import { createLogger } from "../../lib/logger.js";

const defaultLogger = createLogger("pm-outbox");

/** `SystemFlag.key` prefix; the consumer's name follows. */
export const OUTBOX_FLAG_PREFIX = "pm-outbox:";

/** Prisma's interactive-transaction timeout (5 s) plus a second of margin —
 *  the longest a row can sit uncommitted behind its own `createdAt`. */
export const DEFAULT_OUTBOX_SETTLE_MS = 6_000;

export const DEFAULT_OUTBOX_BATCH = 100;

/** How long a row must keep failing before it is treated as poison. */
export const DEFAULT_OUTBOX_POISON_AFTER_MS = 5 * 60_000;

/** A sweep drains at most this many batches, so one pathological backlog
 *  cannot hold the advisory-lock transaction open indefinitely. The rest waits
 *  for the next tick. */
const MAX_BATCHES_PER_SWEEP = 50;

/** Failures a row needs before the poison window applies at all. */
const POISON_MIN_FAILURES = 3;

/** Added to the settle window when a nudge schedules its wake-up. */
const NUDGE_SLACK_MS = 50;

/** A consumer name becomes part of a `SystemFlag` key and an advisory-lock key. */
const CONSUMER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type OutboxRow = PmActivity;

/** The cursor, as stored. A type alias, not an interface, so it is assignable
 *  to Prisma's JSON input. */
export type OutboxCursor = { createdAt: string; id: string };

type OutboxPrisma = Pick<PrismaClient, "pmActivity" | "systemFlag">;

export interface OutboxLogger {
  debug(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface OutboxConsumer {
  /** `[a-z0-9-]`, ≤ 64 chars. Names the cursor and the advisory lock. */
  name: string;
  /** The backstop tick. A nudge makes the common case faster; this is what
   *  guarantees a missed nudge is picked up. */
  intervalMs: number;
  /** Called once per row, oldest first. MUST be idempotent. */
  handle: (row: OutboxRow) => Promise<void>;
  /** Rows per read. Default 100. */
  batchSize?: number;
  /** How long a row must have been still before it is read. See the header. */
  settleMs?: number;
  /** See "A row that never succeeds". Default five minutes. */
  poisonAfterMs?: number;
}

export function outboxFlagKey(consumer: string): string {
  if (!CONSUMER_NAME.test(consumer)) {
    throw new Error(`pm-outbox: invalid consumer name "${consumer}" (use [a-z0-9-], at most 64 characters)`);
  }
  return `${OUTBOX_FLAG_PREFIX}${consumer}`;
}

function parseCursor(value: unknown): OutboxCursor | null {
  if (typeof value !== "object" || value === null) return null;
  const { createdAt, id } = value as Record<string, unknown>;
  if (typeof createdAt !== "string" || typeof id !== "string") return null;
  if (Number.isNaN(Date.parse(createdAt))) return null;
  return { createdAt, id };
}

/**
 * The consumer's cursor, creating it at `now` on first use.
 *
 * Insert-or-skip, then a re-read: two replicas that start together both try to
 * create it, one wins, and both then continue from the winner's. An existing
 * row that does not parse is an ERROR, not a reason to start over — restarting
 * at "now" would silently drop every event since the damage, and "no guessing"
 * applies to state this important.
 */
async function loadCursor(prisma: OutboxPrisma, consumer: string, now: Date): Promise<OutboxCursor> {
  const key = outboxFlagKey(consumer);
  let row = await prisma.systemFlag.findUnique({ where: { key } });
  if (!row) {
    const start: OutboxCursor = { createdAt: now.toISOString(), id: "" };
    await prisma.systemFlag.createMany({ data: [{ key, valueJson: start }], skipDuplicates: true });
    row = await prisma.systemFlag.findUnique({ where: { key } });
  }
  const cursor = parseCursor(row?.valueJson);
  if (!cursor) throw new Error(`pm-outbox: unreadable cursor in SystemFlag "${key}"`);
  return cursor;
}

/**
 * The next rows for `consumer`: strictly after its cursor in `(createdAt, id)`
 * order, and old enough to have settled. At most `limit`.
 */
export async function readOutboxBatch(
  prisma: OutboxPrisma,
  consumer: string,
  limit: number,
  opts: { settleMs?: number; now?: () => Date } = {},
): Promise<OutboxRow[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`pm-outbox: limit must be a positive integer (got ${String(limit)})`);
  }
  const now = (opts.now ?? (() => new Date()))();
  const cursor = await loadCursor(prisma, consumer, now);
  const after = new Date(cursor.createdAt);
  const settledBefore = new Date(now.getTime() - (opts.settleMs ?? DEFAULT_OUTBOX_SETTLE_MS));
  return prisma.pmActivity.findMany({
    where: {
      AND: [
        // Detached deletion tombstones are a private pm-live transport detail.
        // Non-live consumers only see ordinary rows still attached to a work item.
        consumer === "pm-live"
          ? { OR: [{ workItemId: { not: null } }, { deletedWorkItemId: { not: null } }] }
          : { workItemId: { not: null } },
        { OR: [{ createdAt: { gt: after } }, { createdAt: after, id: { gt: cursor.id } }] },
        { createdAt: { lte: settledBefore } },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
  });
}

/**
 * Move `consumer`'s cursor to `row`. Single writer by construction — one
 * consumer, one advisory lock, one sweep at a time — so this does not guard
 * against moving backwards; nothing is in a position to try.
 */
export async function advanceOutboxCursor(
  prisma: OutboxPrisma,
  consumer: string,
  row: Pick<OutboxRow, "id" | "createdAt">,
): Promise<void> {
  const key = outboxFlagKey(consumer);
  const valueJson: OutboxCursor = { createdAt: row.createdAt.toISOString(), id: row.id };
  await prisma.systemFlag.upsert({
    where: { key },
    create: { key, valueJson },
    update: { valueJson },
  });
}

// ── the sweep ────────────────────────────────────────────────────────────────

export interface OutboxSweepDeps {
  /** Clock seam; defaults to the real one. */
  now?: () => Date;
  logger?: OutboxLogger;
}

export interface OutboxSweepResult {
  handled: number;
  deadLettered: number;
}

/** Per-consumer, per-row failure bookkeeping. Keyed by the consumer OBJECT so a
 *  registration owns its own state and a test cannot inherit another's. */
const failures = new WeakMap<OutboxConsumer, Map<string, { firstAt: number; count: number }>>();

/**
 * One pass over everything new for `consumer`, then return. Exposed so tests
 * (and the scheduler) drive the same code.
 */
export async function runOutboxSweep(
  prisma: OutboxPrisma,
  consumer: OutboxConsumer,
  deps: OutboxSweepDeps = {},
): Promise<OutboxSweepResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.logger ?? defaultLogger;
  const batchSize = consumer.batchSize ?? DEFAULT_OUTBOX_BATCH;
  const poisonAfterMs = consumer.poisonAfterMs ?? DEFAULT_OUTBOX_POISON_AFTER_MS;
  let tracked = failures.get(consumer);
  if (!tracked) {
    tracked = new Map();
    failures.set(consumer, tracked);
  }

  let handled = 0;
  let deadLettered = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch += 1) {
    const rows = await readOutboxBatch(prisma, consumer.name, batchSize, {
      settleMs: consumer.settleMs,
      now,
    });
    for (const row of rows) {
      try {
        await consumer.handle(row);
        handled += 1;
      } catch (err) {
        const at = now().getTime();
        const before = tracked.get(row.id);
        const next = { firstAt: before?.firstAt ?? at, count: (before?.count ?? 0) + 1 };
        tracked.set(row.id, next);
        if (next.count >= POISON_MIN_FAILURES && at - next.firstAt >= poisonAfterMs) {
          log.error(
            {
              err,
              consumer: consumer.name,
              rowId: row.id,
              verb: row.verb,
              workItemId: row.workItemId,
              failures: next.count,
            },
            "pm-outbox: row dead-lettered after repeated failures — skipped so later events are not blocked",
          );
          deadLettered += 1;
        } else {
          log.warn(
            { err, consumer: consumer.name, rowId: row.id, failures: next.count },
            "pm-outbox: handler failed — the row will be retried",
          );
          throw err;
        }
      }
      tracked.delete(row.id);
      await advanceOutboxCursor(prisma, consumer.name, row);
    }
    if (rows.length < batchSize) break;
  }
  return { handled, deadLettered };
}

// ── registration and the nudge ───────────────────────────────────────────────

export interface OutboxRegistration {
  prisma: PrismaClient;
  cronRuntime: CronRuntime;
  now?: () => Date;
  logger?: OutboxLogger;
}

interface Registered {
  consumer: OutboxConsumer;
  job: CronJobHandle;
  timer: NodeJS.Timeout | null;
}

const registry = new Map<string, Registered>();

/**
 * Register a consumer: a `cron-runtime` interval under the advisory-lock key
 * `droplet:pm-outbox:<name>`, run once straight away, plus a place in the set
 * `nudgeOutbox` wakes. Call it from `index.ts` main() with the shared
 * `cronRuntime`; WS-9 and WS-19 register theirs the same way.
 */
export function registerOutboxConsumer(consumer: OutboxConsumer, deps: OutboxRegistration): void {
  outboxFlagKey(consumer.name); // validates the name
  if (!Number.isInteger(consumer.intervalMs) || consumer.intervalMs < 1) {
    throw new Error(`pm-outbox: intervalMs must be a positive integer (got ${String(consumer.intervalMs)})`);
  }
  if (registry.has(consumer.name)) {
    throw new Error(`pm-outbox: consumer "${consumer.name}" is already registered`);
  }
  const log = deps.logger ?? defaultLogger;
  const job = deps.cronRuntime.scheduleInterval(
    consumer.intervalMs,
    async () => {
      const result = await runOutboxSweep(deps.prisma, consumer, { now: deps.now, logger: log });
      if (result.handled > 0 || result.deadLettered > 0) {
        log.debug({ consumer: consumer.name, ...result }, "pm-outbox sweep");
      }
    },
    { lockKey: `droplet:pm-outbox:${consumer.name}`, immediate: true },
  );
  registry.set(consumer.name, { consumer, job, timer: null });
}

/**
 * "A PmActivity row was just written." Wakes every registered consumer once
 * that row will have settled, so the common case — one isolated change — is
 * delivered in about `settleMs` rather than up to `settleMs + intervalMs`.
 *
 * It cannot know when the surrounding transaction commits (Prisma has no
 * commit hook), and does not try: the settle window is what makes the read
 * safe, and the interval is what guarantees a row is picked up even if this
 * wake-up is lost or coalesced away. Debounced — a burst of writes re-arms one
 * timer per consumer rather than starting one each — and `unref`'d, so a
 * pending wake-up never holds the process open.
 *
 * Free when nothing is registered: no timer is created, so the existing PM
 * unit tests, which call `writeActivity` against stubs, are unaffected.
 */
export function nudgeOutbox(): void {
  for (const entry of registry.values()) {
    if (entry.timer) clearTimeout(entry.timer);
    const delay = (entry.consumer.settleMs ?? DEFAULT_OUTBOX_SETTLE_MS) + NUDGE_SLACK_MS;
    const timer = setTimeout(() => {
      entry.timer = null;
      entry.job.runNow();
    }, delay);
    timer.unref();
    entry.timer = timer;
  }
}

/** Cancel pending wake-ups and forget every consumer. Shutdown, and tests. */
export function stopOutbox(): void {
  for (const entry of registry.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  registry.clear();
}
