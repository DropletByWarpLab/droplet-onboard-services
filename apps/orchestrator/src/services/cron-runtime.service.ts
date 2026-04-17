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
 * Handler exceptions are caught and logged at `warn` so a single bad
 * tick never takes the runtime down. This is deliberate: the ticker
 * already distinguishes RouterError from unexpected errors internally,
 * so by the time something bubbles out here, we just want to keep
 * subsequent ticks firing.
 *
 * Note on WARP-89: that ticket will add a reconciler poller + cron.
 * When it lands it should reuse this same primitive; no API changes
 * expected.
 */
import cron, { type ScheduledTask } from "node-cron";
import pino from "pino";

const log = pino({ name: "cron-runtime" });

export interface CronRuntime {
  scheduleInterval(ms: number, handler: () => void | Promise<void>): void;
  scheduleCron(spec: string, handler: () => void | Promise<void>): void;
  stop(): void;
}

export function createCronRuntime(): CronRuntime {
  const intervals: NodeJS.Timeout[] = [];
  const crons: ScheduledTask[] = [];

  async function safeRun(handler: () => void | Promise<void>) {
    try {
      await handler();
    } catch (err) {
      log.warn({ err }, "cron handler threw; continuing");
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
