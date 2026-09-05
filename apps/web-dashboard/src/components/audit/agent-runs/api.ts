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
