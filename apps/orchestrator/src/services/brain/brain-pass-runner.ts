/**
 * Brain pass trigger (WARP-2850, ADR-051 §5) — ONE way to start a pass, for
 * the three things that need to.
 *
 * A pass has three callers now: the interval tick, a run shortly after boot,
 * and an operator asking for one. Before this they would have been three code
 * paths with three ideas about exclusion — which is the shape of the defect
 * this epic has already hit twice (two corpus resolvers, two notification
 * vocabularies). So they share one function and one lease.
 *
 * THE BOOT RUN IS THE DETECTOR PASS ONLY, and that is a ruling rather than an
 * omission. Three independent reviews of the design agreed on it:
 *
 *   CONSENT — ADR-051 §9.9 makes `BRAIN_ENABLED` default-off *because* the
 *     corpus pass reads a person's documents through the model. A leading
 *     corpus call means "flip the flag and, seconds later, the model has read
 *     ten of somebody's documents", with no interval in which an operator
 *     could have disabled that pass specifically.
 *   CONTENTION — it is the only pass that touches the box's single inference
 *     slot, and boot is the worst moment for it: cold model, the compose stack
 *     coming up, migrations possibly still settling.
 *   IT WOULD NOT HELP — the reboot argument is about findings, and findings
 *     come from the DETECTOR pass. The corpus pass writes digests. A box that
 *     reboots for OTA more often than the tick now produces findings on every
 *     boot, which is the actual hole.
 *
 * MANUAL RUNS OF THE CORPUS PASS ARE RATE-LIMITED, and the reason is duty
 * cycle rather than politeness. Concurrency is already handled — a second
 * trigger while one is running loses the claim and is told so. But a caller
 * who re-fires the instant a run *ends* holds the only inference slot at
 * essentially 100%, and every one of those inferences is queued ahead of
 * whatever the person in the chat window asks next. The limit reads
 * `lastRunAt` off the row rather than keeping a timer in memory: durable
 * across restarts, and it correctly refuses a manual run moments after a
 * scheduled tick, because the pass genuinely has nothing new to read.
 */
import type { PrismaClient } from "@prisma/client";
import { runWithLease } from "./brain-lease.service.js";

/** The work of one pass. Takes no arguments: everything it needs is closed
 *  over where the runners are built, which is the only place that has the
 *  model client and the config. */
export type PassRunner = () => Promise<void>;

export type TriggerReason =
  | "busy"
  | "disabled"
  | "missing"
  | "unknown_pass"
  | "too_soon"
  | "no_model";

export type TriggerOutcome =
  | { ok: true }
  | { ok: false; reason: TriggerReason; retryAfterMs?: number };

export interface BrainPassTrigger {
  /** Start a pass, or say why not. NEVER waits for the pass to finish. */
  trigger(passKey: string, opts?: { manual?: boolean; now?: Date }): Promise<TriggerOutcome>;
  /** The passes this box can run. The route's allow-list. */
  knownPasses(): readonly string[];
}

export interface TriggerDeps {
  prisma: PrismaClient;
  runners: Readonly<Record<string, PassRunner>>;
  /**
   * Passes a manual trigger must not re-fire immediately, and how soon is too
   * soon. A pass absent from this map has no manual limit — the detector pass
   * is bounded indexed SQL with no model call, so re-running it costs the box
   * nothing anyone would notice.
   */
  manualMinIntervalMs?: Readonly<Record<string, number>>;
}

export function createBrainPassTrigger(deps: TriggerDeps): BrainPassTrigger {
  const { prisma, runners, manualMinIntervalMs = {} } = deps;

  return {
    knownPasses: () => Object.keys(runners),

    async trigger(passKey, opts = {}) {
      const run = runners[passKey];
      // Checked against the RUNNERS map, never against a caller's string. The
      // route validates too; this is the layer that cannot be bypassed by a
      // future caller that forgets.
      if (!run) return { ok: false, reason: "unknown_pass" };

      const now = opts.now ?? new Date();

      if (opts.manual) {
        const minMs = manualMinIntervalMs[passKey];
        if (minMs && minMs > 0) {
          const row = await prisma.brainPass.findUnique({
            where: { passKey },
            select: { lastRunAt: true },
          });
          const last = row?.lastRunAt?.getTime();
          if (last !== undefined) {
            const elapsed = now.getTime() - last;
            if (elapsed < minMs) {
              return { ok: false, reason: "too_soon", retryAfterMs: minMs - elapsed };
            }
          }
        }
      }

      // `runWithLease` claims and returns; the pass itself runs outside. A
      // trigger that awaited the pass would put ten inferences back on
      // whatever called it — a cron tick, or worse, an HTTP request.
      const lease = await runWithLease(prisma, passKey, run, { now });
      if (lease.started) return { ok: true };
      return {
        ok: false,
        reason: (lease.reason as TriggerReason | undefined) ?? "busy",
      };
    },
  };
}

/**
 * Run a pass once, shortly after boot.
 *
 * A `setTimeout`, never an `await` at the registration site: the brain block
 * sits in the same bootstrap as `server.listen()`, and awaiting a pass there
 * would keep the box from answering HTTP until it finished. `.unref()` so a
 * SIGTERM thirty seconds into boot does not wait on it, and the handle is
 * returned so shutdown can clear it.
 *
 * Deliberately silent about the outcome beyond a log: nothing is waiting on
 * this, and a boot run that loses its claim to a tick is not a problem worth
 * telling anybody about.
 */
export function scheduleBootRun(
  trigger: BrainPassTrigger,
  passKey: string,
  delayMs: number,
  onDone?: (outcome: TriggerOutcome) => void,
): NodeJS.Timeout {
  const t = setTimeout(() => {
    void trigger.trigger(passKey).then((outcome) => onDone?.(outcome));
  }, delayMs);
  t.unref?.();
  return t;
}
