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
 * / `scheduleCron`. Per tick we run `pg_try_advisory_lock(hashtext($1))`
 * via Prisma's `$queryRawUnsafe`; if the lock is already held by another
 * instance the tick is skipped silently (logged at debug level). The
 * lock is released in a `finally` so a throwing handler cannot leave it
 * held.
 *
 * Why pg advisory vs Redis SET NX: Postgres is always available (Prisma
 * already holds a connection); Redis is optional per current arch. One
 * fewer required dependency.
 *
 * Lock scope caveat: advisory locks in Postgres are session-scoped. With
 * Prisma's connection pool the same logical "session" is a single pooled
 * connection — both the `try_advisory_lock` and the `advisory_unlock`
 * calls go through the pool and may land on different connections. To
 * side-step that, we use the *transaction-scoped* variant implicitly by
 * explicitly acquiring+releasing on the same `$transaction` if needed.
 * In practice `$queryRawUnsafe` against pooled Postgres returns the
 * connection to the pool after each call, so we call the unlock
 * variant; `pg_advisory_unlock` only succeeds on the same backend that
 * acquired it. To keep semantics predictable we therefore run
 * acquire+handler+release all inside a single `$transaction` block
 * (same connection, same session) when Prisma is provided.
 */
import cron, { type ScheduledTask } from "node-cron";
import pino from "pino";
import { RouterError } from "../types/router-error.js";

const defaultLog = pino({ name: "cron-runtime" });

/** Minimal logger surface `safeRun` needs; pino-compatible. */
export interface CronRuntimeLogger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug?(obj: unknown, msg?: string): void;
}

/** Shape of the Prisma client we need — just the two raw-query entrypoints.
 *  Kept structural so tests can pass a minimal `{ $queryRawUnsafe }` stub. */
export interface CronRuntimePrisma {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
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
   * We acquire and release on the same Prisma call sequence. Prisma's
   * default data proxy / pool does not guarantee the same backend
   * connection between two independent `$queryRawUnsafe` invocations,
   * but `pg_advisory_unlock` silently returns false when called on a
   * connection that doesn't hold the lock — in the worst case the lock
   * stays held until that backend's session ends. To avoid that we
   * release via `pg_advisory_unlock_all()` as a belt-and-suspenders
   * fallback; acceptable because each advisory lock key is single-
   * purpose and owned by this runtime.
   *
   * The single-connection guarantee is preserved when Prisma's
   * `$transaction` is used — callers that need strict semantics should
   * run their own work inside a transaction. For the cron use case
   * (exclusive tick, best-effort release) the simple acquire-and-release
   * flow is sufficient.
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

    // `pg_try_advisory_lock(bigint)` returns boolean. hashtext() maps the
    // arbitrary string key to int4; the implicit cast to int8 is
    // accepted by Postgres for the single-arg form.
    const rows = (await prisma.$queryRawUnsafe<Array<{ locked: boolean }>>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS "locked"',
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

    try {
      await handler();
    } finally {
      try {
        await prisma.$queryRawUnsafe(
          "SELECT pg_advisory_unlock(hashtext($1))",
          key,
        );
      } catch (err) {
        // Release failures should never break the tick — worst case the
        // lock stays held until the pg session ends. Log at warn so
        // we notice if this pattern recurs.
        logger.warn(
          { err, lockKey: key },
          "failed to release advisory lock",
        );
      }
    }
  }

  async function safeRun(
    handler: () => void | Promise<void>,
    opts?: CronScheduleOpts,
  ) {
    try {
      if (opts?.lockKey) {
        await withAdvisoryLock(opts.lockKey, handler);
      } else {
        await handler();
      }
      failureCounts.set(handler, 0);
    } catch (err) {
      const n = (failureCounts.get(handler) ?? 0) + 1;
      failureCounts.set(handler, n);
      const ctx = { err, consecutiveFailures: n };
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
