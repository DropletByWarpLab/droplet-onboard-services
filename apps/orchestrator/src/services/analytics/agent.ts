/**
 * WARP-615 — analytics agent orchestration shell.
 *
 * Decision D1: ONE agent embedded in the orchestrator owns registration,
 * batching, and the single outbound connection to the fleet portal. This
 * story lands only the shell — the agent implements the Analytics façade but
 * deliberately delivers nothing yet:
 *
 *   - WARP-616 attaches registration/identity inside start() (readiness
 *     gate E3: buffers accumulate until a token exists).
 *   - WARP-617 gives the façade methods a bounded buffer to enqueue into and
 *     attaches the flush cadences via cron-runtime.service.ts
 *     `scheduleInterval` (NEVER a raw `while true`/setInterval loop here).
 *   - WARP-618/619/620 feed it service-health, LLM metadata, and heartbeats.
 *
 * Keeping the shell inert (no I/O, no timers) is load-bearing: the fail-open
 * wrapper + Noop selection in index.ts are the permanent contract this story
 * proves, and later stories only change what happens INSIDE this class.
 */
import type { AnalyticsClient } from "./client.js";
import type {
  Analytics,
  AnalyticsErrorInput,
  AnalyticsEventInput,
  AnalyticsLlmRecord,
  AnalyticsServiceRecord,
} from "./types.js";

export interface AnalyticsAgentOptions {
  client: AnalyticsClient;
}

export class AnalyticsAgent implements Analytics {
  /** Wire I/O — unused until WARP-616/617 attach delivery. */
  readonly client: AnalyticsClient;
  private started = false;

  constructor(opts: AnalyticsAgentOptions) {
    this.client = opts.client;
  }

  /**
   * Boot hook. Idempotent. Inert today — WARP-616 (registration) and
   * WARP-617 (buffer flush intervals on cron-runtime) attach here.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
  }

  /** Teardown hook for the shutdown path. Idempotent. */
  stop(): void {
    this.started = false;
  }

  // ── Façade ──────────────────────────────────────────────────────────────
  // Inert in the skeleton: WARP-617's bounded buffer is where these enqueue.
  // They accept (and drop) input so call sites added by WARP-618/619 compile
  // and behave identically whether the buffer exists yet or not.

  event(_input: AnalyticsEventInput): void {}

  metric(
    _name: string,
    _value: number,
    _labels?: Record<string, string>,
  ): void {}

  error(_input: AnalyticsErrorInput): void {}

  recordLlm(_record: AnalyticsLlmRecord): void {}

  recordService(_record: AnalyticsServiceRecord): void {}
}
