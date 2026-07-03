/**
 * WARP-615 — fleet-analytics agent types.
 *
 * The on-device analytics agent (embedded in the orchestrator, decision D1)
 * emits telemetry to the droplet-analytics fleet portal. Two families of
 * types live here:
 *
 *   1. The `Analytics` FAÇADE — what business code calls. Fire-and-forget:
 *      every method returns void and (via the fail-open wrapper in index.ts)
 *      can never throw into the caller.
 *   2. WIRE shapes — what client.ts serializes onto the portal's agent-API
 *      (droplet-analytics docs/agent-api.md §2–§5). Wire timestamps are
 *      ISO-8601 with timezone.
 *
 * PRIVACY INVARIANT (decision D4): telemetry is METADATA ONLY. No prompt or
 * response text, no file contents, no user content — ever. Payload shapes
 * added by later stories (WARP-618/619) must uphold this.
 */

// ---------------------------------------------------------------------------
// Severities (portal contract: events info|warn|error|critical, errors
// error|critical — agent-api.md §4/§5).
// ---------------------------------------------------------------------------

export type AnalyticsEventSeverity = "info" | "warn" | "error" | "critical";
export type AnalyticsErrorSeverity = "error" | "critical";

// ---------------------------------------------------------------------------
// Façade inputs — `ts` optional everywhere; the agent stamps enqueue time
// when the caller omits it.
// ---------------------------------------------------------------------------

/** Domain event (agent-api.md §4). `type` is a dotted namespace; the portal
 * pre-indexes `user.*`, `service.*`, `ai.*`, `network.*`, `system.*`, … */
export interface AnalyticsEventInput {
  type: string;
  severity?: AnalyticsEventSeverity;
  actor?: string;
  target?: string;
  payload?: Record<string, unknown>;
  ts?: string;
}

/** Critical/error report (agent-api.md §5). `fingerprint` is a device-side
 * hash of the normalized message + top frame; the portal dedups on it. */
export interface AnalyticsErrorInput {
  severity?: AnalyticsErrorSeverity;
  fingerprint: string;
  service: string;
  title: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
  ts?: string;
}

/**
 * One LLM call/run observation — the WARP-619 seam. Metadata only (D4):
 * model/provider/latency/tokens/tool COUNTS, never content. Token fields are
 * OMITTED (not zeroed) when the provider returns no usage.
 */
export interface AnalyticsLlmRecord {
  model: string;
  provider: string;
  latencyMs: number;
  ok: boolean;
  promptTokens?: number;
  completionTokens?: number;
  toolCalls?: number;
  iterations?: number;
  stopReason?: string;
  errorClass?: string;
}

/**
 * One service-health observation per component per health-monitor poll —
 * the WARP-618 seam. Transition-only event derivation happens in the agent.
 */
export interface AnalyticsServiceRecord {
  service: string;
  status: "ok" | "degraded" | "down";
  latencyMs?: number;
  error?: string;
}

/**
 * The analytics façade. Everything business code may call. All methods are
 * fire-and-forget void — callers MUST NOT depend on delivery for their own
 * control flow, and (wrapped fail-open) calls can never throw.
 */
export interface Analytics {
  event(input: AnalyticsEventInput): void;
  metric(name: string, value: number, labels?: Record<string, string>): void;
  error(input: AnalyticsErrorInput): void;
  recordLlm(record: AnalyticsLlmRecord): void;
  recordService(record: AnalyticsServiceRecord): void;
}

// ---------------------------------------------------------------------------
// Wire shapes (client.ts ⇄ portal). Field names are snake_case where the
// portal contract says so — do not "fix" them.
// ---------------------------------------------------------------------------

/** One metrics-batch sample (agent-api.md §3, ≤5000 per request). */
export interface AnalyticsMetricSample {
  ts: string;
  name: string;
  value: number;
  labels?: Record<string, string>;
}

/** One batched domain event on the wire (agent-api.md §4, ≤100 per request). */
export interface AnalyticsWireEvent {
  ts: string;
  type: string;
  severity: AnalyticsEventSeverity;
  actor?: string;
  target?: string;
  payload?: Record<string, unknown>;
}

/** Single error report on the wire (agent-api.md §5 — one object, no batch). */
export interface AnalyticsWireError {
  ts: string;
  severity: AnalyticsErrorSeverity;
  fingerprint: string;
  service: string;
  title: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}

/**
 * Heartbeat body (agent-api.md §2). Only `ts` is structurally required;
 * WARP-620 assembles the full minimal payload (uptime, load, cpu, ram,
 * containers_up/total derived from the health monitor per decision D6).
 */
export interface AnalyticsHeartbeatBody {
  ts: string;
  uptime_s?: number;
  load?: { "1m": number; "5m": number; "15m": number };
  cpu_pct?: number;
  ram?: { used_mb: number; total_mb: number };
  containers_up?: number;
  containers_total?: number;
  [key: string]: unknown;
}

/** POST /agents/events response. */
export interface AnalyticsEventsResult {
  accepted: number;
  rejected: unknown[];
}

/** POST /agents/errors response (`count` = new total after upsert). */
export interface AnalyticsErrorResult {
  error_id: string;
  count: number;
  deduped: boolean;
}
