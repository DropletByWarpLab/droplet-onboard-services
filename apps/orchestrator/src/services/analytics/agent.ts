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
 *   - WARP-618 (landed below): recordService derives the per-poll
 *     `service.health` metric + transition-only `service.*` events.
 *   - WARP-619/620 feed it LLM metadata and heartbeats.
 *
 * Keeping the shell inert (no I/O, no timers) is load-bearing: the fail-open
 * wrapper + Noop selection in index.ts are the permanent contract WARP-615
 * proved, and later stories only change what happens INSIDE this class —
 * WARP-618's derivation lands on the still-inert metric()/event() seams, so
 * it starts delivering automatically the moment WARP-617's buffer exists.
 */
import type { AnalyticsClient } from "./client.js";
import type {
  Analytics,
  AnalyticsErrorInput,
  AnalyticsEventInput,
  AnalyticsEventSeverity,
  AnalyticsLlmRecord,
  AnalyticsServiceRecord,
} from "./types.js";

// ── WARP-618: service-health derivation tables ─────────────────────────────

/** `service.health` sample value per status — a plain 1 / 0.5 / 0 scale so
 * the portal can average samples straight into an uptime percentage. */
const SERVICE_HEALTH_VALUE: Record<AnalyticsServiceRecord["status"], number> = {
  ok: 1,
  degraded: 0.5,
  down: 0,
};

/** Transition event derived from the NEW status. `service.*` is a portal
 * pre-indexed namespace (agent-api.md §4); severity mirrors status weight. */
const SERVICE_TRANSITION_EVENT: Record<
  AnalyticsServiceRecord["status"],
  { type: string; severity: AnalyticsEventSeverity }
> = {
  ok: { type: "service.up", severity: "info" },
  degraded: { type: "service.degraded", severity: "warn" },
  down: { type: "service.down", severity: "error" },
};

export interface AnalyticsAgentOptions {
  client: AnalyticsClient;
}

export class AnalyticsAgent implements Analytics {
  /** Wire I/O — unused until WARP-616/617 attach delivery. */
  readonly client: AnalyticsClient;
  private started = false;

  /** WARP-618: last observed status per service — the diff base that makes
   * `service.*` events transition-only. */
  private readonly lastServiceStatus = new Map<
    string,
    AnalyticsServiceRecord["status"]
  >();

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
    // WARP-618: drop transition baselines — a stopped-then-restarted agent
    // must re-baseline rather than fabricate a transition from stale
    // pre-stop state.
    this.lastServiceStatus.clear();
  }

  // ── Façade ──────────────────────────────────────────────────────────────
  // metric/event/error/recordLlm are inert until WARP-617's bounded buffer
  // gives them somewhere to enqueue. They accept (and drop) input so call
  // sites — including recordService's derivation below — compile and behave
  // identically whether the buffer exists yet or not.

  event(_input: AnalyticsEventInput): void {}

  metric(
    _name: string,
    _value: number,
    _labels?: Record<string, string>,
  ): void {}

  error(_input: AnalyticsErrorInput): void {}

  recordLlm(_record: AnalyticsLlmRecord): void {}

  /**
   * WARP-618 — one observation per component per health-monitor poll.
   *
   * Channel choice: call sites use `recordService` (not raw `metric()` /
   * `event()`) because the portal has no "service record" wire shape — the
   * agent owns the translation into what agent-api.md §3/§4 actually accept,
   * exactly as types.ts pinned when it declared this record "the WARP-618
   * seam" with derivation in the agent:
   *
   *   - metric `service.health` on EVERY observation
   *     (value 1 = ok, 0.5 = degraded, 0 = down; labels `{ service }`), and
   *   - event `service.up|degraded|down` ONLY when the status CHANGED since
   *     the previous observation of that service — steady state emits
   *     nothing, keeping the event stream far under the 30/min budget.
   *
   * First-ever observation of a service is a BASELINE, not a transition: no
   * prior state means nothing "changed", so no event. A box that boots with
   * a component already down still reports it via the metric stream (value 0
   * every poll); the event stream only speaks on state change.
   *
   * Privacy (D4): the payload carries operational metadata only — probe
   * latency plus the health-monitor's component error SUMMARY ("probe timed
   * out", connection failures); never file contents or user content.
   */
  recordService(record: AnalyticsServiceRecord): void {
    this.metric("service.health", SERVICE_HEALTH_VALUE[record.status], {
      service: record.service,
    });

    const prev = this.lastServiceStatus.get(record.service);
    this.lastServiceStatus.set(record.service, record.status);
    if (prev === undefined || prev === record.status) return;

    const { type, severity } = SERVICE_TRANSITION_EVENT[record.status];
    const payload: Record<string, unknown> = {};
    if (record.latencyMs !== undefined) payload.latencyMs = record.latencyMs;
    if (record.error !== undefined) payload.error = record.error;
    this.event({ type, severity, target: record.service, payload });
  }
}
