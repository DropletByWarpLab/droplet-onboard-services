/**
 * WARP-2180 — the agent-runs wire surface, as the dashboard reads it.
 *
 * Mirrors `apps/orchestrator/src/routes/agent-runs.ts`. Every call goes
 * through `authFetch` (session cookie + request id). A non-OK response is
 * thrown as an Error with the route's own message when it sent one, so the
 * panel can show a calm line and keep the raw cause in a title attribute.
 */
import { authFetch } from "@/lib/auth";

export type AgentRunStatus =
  | "queued"
  | "running"
  | "awaiting_confirmation"
  | "succeeded"
  | "failed"
  | "cancelled";

export const AGENT_RUN_STATUSES: readonly AgentRunStatus[] = [
  "queued",
  "running",
  "awaiting_confirmation",
  "succeeded",
  "failed",
  "cancelled",
];

export const STATUS_LABELS: Record<AgentRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  awaiting_confirmation: "Needs approval",
  succeeded: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** A run that can still change. Drives polling. */
export const LIVE_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "awaiting_confirmation",
]);

export interface SummaryField {
  key: string;
  kind: string;
  detail: string;
  value?: boolean;
}

export interface PendingCall {
  tool: string;
  args: Record<string, unknown>;
  summary: { tool: string; fields: SummaryField[]; truncatedFields: number };
  parkedAt: string | null;
  decision: "approved" | "denied" | null;
  decidedAt: string | null;
}

export interface TraceEntry {
  tool_call_id: string;
  tool: string;
  args: Record<string, unknown>;
  iteration: number;
  dispatchedAt: string;
  text?: string;
  isError?: boolean;
  completedAt?: string;
  replayOf?: string;
  confirmation?: "parked" | "confirmed" | "denied";
  /** WARP-2877 — dispatched, outcome lost to a restart, not repeated. */
  unknownOutcome?: true;
}

export interface AgentRunSummary {
  id: string;
  goal: string;
  model: string;
  status: AgentRunStatus;
  iteration: number;
  maxIter: number;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  deadlineAt: string | null;
  result: string | null;
  stopReason: string | null;
  error: string | null;
  pending: PendingCall | null;
}

export interface AgentRunDetail extends AgentRunSummary {
  trace: TraceEntry[];
}

async function readError(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(body?.error ? `${fallback} (${body.error})` : `${fallback} (HTTP ${res.status})`);
}

export async function listAgentRuns(params: {
  status?: string;
  limit?: number;
}): Promise<{ items: AgentRunSummary[]; nextCursor: string | null }> {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  qs.set("limit", String(params.limit ?? 25));
  const res = await authFetch(`/api/agent-runs?${qs.toString()}`);
  if (!res?.ok) throw await readError(res, "Couldn't load background runs");
  return (await res.json()) as { items: AgentRunSummary[]; nextCursor: string | null };
}

export async function getAgentRun(id: string): Promise<AgentRunDetail> {
  const res = await authFetch(`/api/agent-runs/${encodeURIComponent(id)}`);
  if (!res?.ok) throw await readError(res, "Couldn't load this run");
  return (await res.json()) as AgentRunDetail;
}

export async function cancelAgentRun(id: string): Promise<void> {
  const res = await authFetch(`/api/agent-runs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  if (!res?.ok) throw await readError(res, "Couldn't cancel this run");
}

export async function decideAgentRun(id: string, decision: "approved" | "denied"): Promise<void> {
  const res = await authFetch(`/api/agent-runs/${encodeURIComponent(id)}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  if (!res?.ok) throw await readError(res, decision === "approved" ? "Couldn't approve" : "Couldn't deny");
}

// ── Recurring runs (AgentRunSchedule, WARP-2180) ────────────────────────────

export interface AgentRunSchedule {
  id: string;
  goal: string;
  model: string;
  maxIter: number;
  rrule: string;
  timezone: string;
  nextFireAt: string;
  enabled: boolean;
  lastFiredAt: string | null;
  createdAt: string;
}

/**
 * The RRULE subset the ticker accepts (`utils/rrule.ts`): FREQ=DAILY or
 * FREQ=WEEKLY with BYDAY/BYHOUR/BYMINUTE, wall-clock in the schedule's IANA
 * timezone. Offered as presets so the common cases never need the syntax.
 */
export const RRULE_PRESETS: ReadonlyArray<{ key: string; label: string; rrule: string }> = [
  { key: "daily-6", label: "Every day at 06:00", rrule: "FREQ=DAILY;BYHOUR=6;BYMINUTE=0" },
  { key: "weekdays-9", label: "Weekdays at 09:00", rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0" },
  { key: "monday-8", label: "Every Monday at 08:00", rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=0" },
];

/** A preset's label when the rule is one, else the rule itself. */
export function describeRrule(rrule: string): string {
  return RRULE_PRESETS.find((p) => p.rrule === rrule)?.label ?? rrule;
}

export async function listAgentRunSchedules(): Promise<AgentRunSchedule[]> {
  const res = await authFetch("/api/agent-runs/schedules");
  if (!res?.ok) throw await readError(res, "Couldn't load recurring runs");
  const body = (await res.json()) as { schedules?: AgentRunSchedule[] };
  return body.schedules ?? [];
}

export async function createAgentRunSchedule(input: {
  goal: string;
  rrule: string;
  timezone: string;
}): Promise<{ id: string; nextFireAt: string }> {
  const res = await authFetch("/api/agent-runs/schedules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res?.ok) throw await readError(res, "Couldn't add this recurring run");
  return (await res.json()) as { id: string; nextFireAt: string };
}

export async function deleteAgentRunSchedule(id: string): Promise<void> {
  const res = await authFetch(`/api/agent-runs/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res?.ok) throw await readError(res, "Couldn't delete this recurring run");
}
