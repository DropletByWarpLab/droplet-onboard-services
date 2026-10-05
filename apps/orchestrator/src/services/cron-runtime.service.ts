/**
 * Minimal cron primitive used by the schedule ticker (WARP-93) and the
 * daily purge cron. Wraps `setInterval` + `node-cron` behind a tiny
 * interface so the orchestrator has exactly one place that owns
 * recurring timers / cron specs.
 *
 * `scheduleInterval` is used for the 30s schedule ticker.
 * `scheduleCron` is used for the 03:00 daily purge job.
 * `stop()` tears down every registered timer/task — the lifespan hook
 *   in `index.ts` calls it during graceful shutdown so Vitest / the
 *   Node runtime can exit cleanly.
 *
 * Error-severity policy in `safeRun`:
 *   - `RouterError` → `warn`. The ticker already catches these
 *     per-device and logs them in context; this is a belt-and-suspenders
 *     catch for anything that slips past.
 *   - Any other `Error` → `error`. Prisma connection loss, null-deref,
 *     etc. should be loud so downstream alerting can key on them.
 *
 * We also track a consecutive-failure streak per registered handler via
 * a `WeakMap` keyed on the handler function identity. Each successful
 * run resets the streak to zero; each failure increments it and the
 * current streak length is attached to the log line as
 * `consecutiveFailures`. Downstream alerting can fire on
 * `consecutiveFailures >= N` without needing log aggregation.
 *
 * Note on WARP-89: that ticket will add a reconciler poller + cron.
 * When it lands it should reuse this same primitive; no API changes
 * expected.
 *
 * ── Critical fix #1: single-instance cron lock ──
 * In a multi-instance orchestrator deploy (K8s replicas, warm standby)
 * every replica fires its own tick simultaneously, causing duplicate
 * firewall writes, racy `deleteMany`s, etc. Callers can opt-in to a
 * Postgres advisory lock by passing `opts.lockKey` to `scheduleInterval`
 * / `scheduleCron`. Per tick we run
 * `pg_try_advisory_xact_lock(hashtext($1))` inside a `$transaction`; if
 * the lock is already held by another instance the tick is skipped
 * silently (logged at debug level). The lock is transaction-scoped, so
 * Postgres releases it at commit/rollback — a throwing handler cannot
 * leave it held, and release always lands on the acquiring backend.
 *
 * Why pg advisory vs Redis SET NX: Postgres is always available (Prisma
 * already holds a connection); Redis is optional per current arch. One
 * fewer required dependency.
 *
 * Lock scope caveat: advisory locks in Postgres are session-scoped, and
 * `pg_advisory_unlock` only succeeds on the *same backend* that acquired
 * the lock. With Prisma's connection pool, two independent
 * `$queryRawUnsafe` calls can land on different pooled connections — so a
 * naive acquire-then-release pair risks releasing on the wrong backend
 * (the unlock returns false) and leaking the session-level lock until that
 * backend's session ends. A leaked key then blocks every other replica's
 * `pg_try_advisory_lock` for that key, silently skipping the cron
 * fleet-wide.
 *
 * Fix: use the *transaction-scoped* variant `pg_advisory_xact_lock`
 * (technically `pg_try_advisory_xact_lock`, the non-blocking try form)
 * inside a single `prisma.$transaction`. Acquire at the top of the
 * transaction, run the handler inside it, and Postgres releases the lock
 * automatically at commit/rollback — on the same backend, with no explicit
 * unlock and no leak path. A throwing handler rolls the transaction back,
 * which still releases the lock. This replaces the previous
 * acquire/`pg_advisory_unlock` pair that could release on the wrong pooled
 * connection.
 */
import cron, { type ScheduledTask } from "node-cron";
import { RouterError } from "../types/router-error.js";
import {
  newRequestId,
  runWithRequestId,
  getRequestId,
} from "../lib/request-context.js";
import { createLogger } from "../lib/logger.js";

const defaultLog = createLogger("cron-runtime");

/**
 * WARP-3193 PERF-1 — the lock transaction lives exactly as long as the handler.
 *
 * It used to be `{ timeout: 60_000 }`. When a handler outlived that (a 40-60
 * device bedtime flip in the schedule ticker, the OTA apply window pulling and
 * recreating images), Prisma rolled the transaction back, Postgres released the
 * xact lock, and the handler — which is not cancelled — ran on UNLOCKED while
 * the next tick (or another replica) started a second copy. The eventual
 * commit then threw P2028 into `safeRun` on a run that had partly succeeded.
 *
 * Two correct fixes were on the table: keep the lock for the whole run, or hand
 * long jobs to a lease row with a heartbeat (the brain-pass / agent-run
 * pattern). Keeping the lock is the simpler one and is chosen here:
 *   - no schema, no heartbeat timer, no fencing, no TTL to tune;
 *   - Postgres still ties the lock to the backend, so a crashed process frees
 *     it at once instead of wedging the job for a lease window;
 *   - the cost is one pooled connection sitting idle-in-transaction for the
 *     length of a long run. It has no xid and, at READ COMMITTED, holds no
 *     snapshot between statements, so it does not hold back vacuum.
 * A lease is still the right tool when the work must SURVIVE a restart
 * (brain passes, filing, agent runs) — that is a different requirement.
 *
 * The largest value `setTimeout` accepts (~24.8 days): effectively "no
 * deadline" without tripping Node's overflow-to-1 ms behaviour anywhere a
 * timer backs it. A handler that genuinely hangs holds its lock until the
 * process restarts — the same as a lease whose heartbeat keeps beating.
 */
export const LOCK_TX_TIMEOUT_MS = 2_147_483_647;

/** Minimal logger surface `safeRun` needs; pino-compatible. */
export interface CronRuntimeLogger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug?(obj: unknown, msg?: string): void;
}

/** Shape of the Prisma client we need.
 *
 *  `$transaction` is used by `withAdvisoryLock` to pin acquire+release to a
 *  single backend connection (see the comment on `withAdvisoryLock`). Kept
 *  structural so tests can pass a minimal stub: the callback receives a `tx`
 *  exposing the same `$queryRawUnsafe`.
 *
 *  Kept structural so tests can pass a minimal `{ $queryRawUnsafe,
 *  $transaction }` stub. */
export interface CronRuntimeTx {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}
export interface CronRuntimePrisma extends CronRuntimeTx {
  $transaction<T>(
    fn: (tx: CronRuntimeTx) => Promise<T>,
    opts?: { timeout?: number },
  ): Promise<T>;
}

export interface CronScheduleOpts {
  /**
   * When set, wrap the handler in a Postgres advisory lock keyed on this
   * string. If another replica holds the lock the tick is skipped. No-op
   * if `createCronRuntime` was called without a prisma handle.
   */
  lockKey?: string;
  /**
   * WARP-3193 QUAL-7 — `scheduleInterval` only: also run once right away,
   * instead of first waiting a full interval (a poller that seeds a cache or
   * catches the screen up on boot). That first run goes through the same
   * overlap guard, so an interval tick cannot start beside it.
   */
  immediate?: boolean;
}

/**
 * WARP-3532 — what `scheduleInterval` hands back. A registration can be run
 * EARLY, through the exact path a tick takes: the advisory lock, the overlap
 * guard and `safeRun`'s failure accounting. The PmActivity outbox uses it to
 * wake a consumer right after a write instead of making the write wait out the
 * interval, and gets no second lock or overlap implementation for it.
 */
export interface CronJobHandle {
  /**
   * Run the handler now, as a tick would. If a run of this registration is
   * already in flight the call is a no-op — skipped, never queued, like a tick
   * that arrives mid-run. Never throws or rejects.
   */
  runNow(): void;
}

export interface CronRuntime {
  scheduleInterval(
    ms: number,
    handler: () => void | Promise<void>,
    opts?: CronScheduleOpts,
  ): CronJobHandle;
  scheduleCron(
    spec: string,
    handler: () => void | Promise<void>,
    opts?: CronScheduleOpts,
  ): void;
  stop(): void;
}

export function createCronRuntime(
  prisma?: CronRuntimePrisma,
  logger: CronRuntimeLogger = defaultLog,
): CronRuntime {
  const intervals: NodeJS.Timeout[] = [];
  const crons: ScheduledTask[] = [];
  // Per-handler consecutive-failure counter. WeakMap so handlers that
  // go out of scope (e.g. when the runtime is stopped) don't pin their
  // closures here.
  const failureCounts = new WeakMap<() => void | Promise<void>, number>();

  /**
   * Acquire a pg advisory lock, run `handler`, release the lock. If the
   * lock can't be acquired, skip the handler (another instance has it).
   *
   * Release is connection-safe: acquire, handler, and the implicit
   * release all run inside a single `prisma.$transaction`, so every
   * statement uses the same pinned backend connection. We use the
   * transaction-scoped `pg_try_advisory_xact_lock`, which Postgres
   * releases automatically when the transaction commits OR rolls back —
   * there is no explicit `pg_advisory_unlock` and therefore no path where
   * the release lands on a different pooled connection than the acquire
   * (the bug that the old session-scoped pair + the never-implemented
   * `pg_advisory_unlock_all()` fallback comment described). A throwing
   * handler rolls the transaction back, which still releases the lock; we
   * re-throw so `safeRun` records the failure.
   */
  async function withAdvisoryLock(
    key: string,
    handler: () => void | Promise<void>,
  ): Promise<void> {
    if (!prisma) {
      // No prisma handle wired up — degrade to no-lock behavior. This
      // keeps tests and single-instance deploys working; production
      // wiring in index.ts always passes prisma.
      await handler();
      return;
    }

    await prisma.$transaction(
      async (tx) => {
        // `pg_try_advisory_xact_lock(bigint)` returns boolean and holds the
        // lock for the life of THIS transaction only. hashtext() maps the
        // arbitrary string key to int4; the implicit cast to int8 is
        // accepted by Postgres for the single-arg form.
        const rows = (await tx.$queryRawUnsafe<Array<{ locked: boolean }>>(
          'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS "locked"',
          key,
        )) as Array<{ locked: boolean }>;
        const acquired = Array.isArray(rows) && rows[0]?.locked === true;
        if (!acquired) {
          logger.debug?.(
            { lockKey: key },
            "cron handler skipped — advisory lock held by another instance",
          );
          return;
        }

        // Handler runs INSIDE the transaction so the xact lock is held for
        // its full duration and released atomically at commit/rollback.
        await handler();
      },
      { timeout: LOCK_TX_TIMEOUT_MS },
    );
  }

  /**
   * WARP-3193 PERF-1 — at most one run of a registration at a time in this
   * process. A tick that arrives while the previous run is still going is
   * SKIPPED, never queued: every handler here is a sweep or a cursor, so the
   * next tick picks up whatever this one would have done. Per registration
   * (one flag per `schedule*` call), so a slow job never holds back another.
   */
  function guarded(
    handler: () => void | Promise<void>,
    opts?: CronScheduleOpts,
  ): () => void {
    let inFlight = false;
    return () => {
      if (inFlight) {
        logger.debug?.(
          { lockKey: opts?.lockKey },
          "cron handler skipped — previous run still in flight",
        );
        return;
      }
      inFlight = true;
      // safeRun never rejects.
      void safeRun(handler, opts).finally(() => {
        inFlight = false;
      });
    };
  }

  async function safeRun(
    handler: () => void | Promise<void>,
    opts?: CronScheduleOpts,
  ) {
    const requestId = newRequestId();
    try {
      await runWithRequestId(requestId, async () => {
        logger.debug?.({ requestId }, "tick-start");
        if (opts?.lockKey) {
          await withAdvisoryLock(opts.lockKey, handler);
        } else {
          await handler();
        }
        logger.debug?.({ requestId }, "tick-end");
      });
      failureCounts.set(handler, 0);
    } catch (err) {
      const n = (failureCounts.get(handler) ?? 0) + 1;
      failureCounts.set(handler, n);
      const ctx = { err, consecutiveFailures: n, requestId };
      if (err instanceof RouterError) {
        logger.warn(ctx, "cron handler caught RouterError");
      } else {
        logger.error(ctx, "cron handler threw unexpected error");
      }
    }
  }

  return {
    scheduleInterval(ms, handler, opts) {
      const run = guarded(handler, opts);
      intervals.push(setInterval(run, ms));
      if (opts?.immediate) run();
      return { runNow: run };
    },
    scheduleCron(spec, handler, opts) {
      const task = cron.schedule(spec, guarded(handler, opts));
      crons.push(task);
    },
    stop() {
      intervals.forEach(clearInterval);
      intervals.length = 0;
      crons.forEach((t) => t.stop());
      crons.length = 0;
    },
  };
}
