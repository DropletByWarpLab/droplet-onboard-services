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
import pino from "pino";
import { RouterError } from "../types/router-error.js";
import {
  newRequestId,
  runWithRequestId,
  getRequestId,
} from "../lib/request-context.js";

const defaultLog = pino({ name: "cron-runtime" });

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
}

export interface CronRuntime {
  scheduleInterval(
    ms: number,
    handler: () => void | Promise<void>,
    opts?: CronScheduleOpts,
  ): void;
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
      { timeout: 60_000 },
    );
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
      intervals.push(setInterval(() => {
        void safeRun(handler, opts);
      }, ms));
    },
    scheduleCron(spec, handler, opts) {
      const task = cron.schedule(spec, () => {
        void safeRun(handler, opts);
      });
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
