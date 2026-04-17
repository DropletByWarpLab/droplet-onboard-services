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
 */
import cron, { type ScheduledTask } from "node-cron";
import pino from "pino";
import { RouterError } from "../types/router-error.js";

const defaultLog = pino({ name: "cron-runtime" });

/** Minimal logger surface `safeRun` needs; pino-compatible. */
export interface CronRuntimeLogger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface CronRuntime {
  scheduleInterval(ms: number, handler: () => void | Promise<void>): void;
  scheduleCron(spec: string, handler: () => void | Promise<void>): void;
  stop(): void;
}

export function createCronRuntime(
  logger: CronRuntimeLogger = defaultLog,
): CronRuntime {
  const intervals: NodeJS.Timeout[] = [];
  const crons: ScheduledTask[] = [];
  // Per-handler consecutive-failure counter. WeakMap so handlers that
  // go out of scope (e.g. when the runtime is stopped) don't pin their
  // closures here.
  const failureCounts = new WeakMap<() => void | Promise<void>, number>();

  async function safeRun(handler: () => void | Promise<void>) {
    try {
      await handler();
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
    scheduleInterval(ms, handler) {
      intervals.push(setInterval(() => {
        void safeRun(handler);
      }, ms));
    },
    scheduleCron(spec, handler) {
      const task = cron.schedule(spec, () => {
        void safeRun(handler);
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
