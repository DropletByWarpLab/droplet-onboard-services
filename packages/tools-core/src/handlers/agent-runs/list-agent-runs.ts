/**
 * WARP-2180 — `list_agent_runs`: the person's background runs, newest
 * first (epic WARP-2176). Read-only; the orchestrator route scopes the list
 * to the person this turn acts for, so the model can never see another
 * user's runs. A run parked on a Tier-2 call shows what it is waiting for.
 *
 * WARP-3302 — two narrowings, both still read-only:
 *   - `run_id` returns ONE run in full (summary, artifacts, what it waits
 *     on; never the trace) — "how is the supplier research going?". This is
 *     an argument rather than a separate `get_agent_run` tool because the
 *     full-registry serialization gate had 121 chars of room: a second tool
 *     costs ~470, an argument ~60. Another user's run is a 404.
 *   - `this_chat` narrows the list to the runs this conversation started.
 *     The conversation id comes from the server-set context
 *     (`ctx.conversationId`), never from arguments.
 *
 * NOT A POLLING TOOL. A chat-started run posts its result into the thread by
 * itself (WARP-3300); the description tells the model to call this when the
 * person asks, never in a loop to wait on a run.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const STATUSES = ["queued", "running", "awaiting_confirmation", "succeeded", "failed", "cancelled"] as const;

const inputSchema = {
  type: "object",
  properties: {
    run_id: { type: "string", description: "One run, in full." },
    status: {
      type: "string",
      enum: [...STATUSES],
      description: "Only runs in this state.",
    },
    this_chat: { type: "boolean", description: "Only runs started in this chat." },
    limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 10." },
  },
  additionalProperties: false,
} as const;

interface RunItem {
  id: string;
  goal: string;
  title?: string;
  status: string;
  createdAt: string;
  endedAt: string | null;
  iteration: number;
  maxIter: number;
  error: string | null;
  result: string | null;
  summary?: string | null;
  artifacts?: unknown[];
  queuePosition?: number | null;
  waitingFor?: string | null;
  pending: { tool: string; parkedAt: string | null; summary?: string } | null;
  /** WARP-2896 — set on a workshop run. */
  workspaceId?: string | null;
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

/** WARP-3302 — one run, the fields that answer "how is it going". */
async function oneRun(runId: string, ctx: ToolContext, userId: string): Promise<ToolResult> {
  const qs = new URLSearchParams({ onBehalfOf: userId });
  const res = await ctx.http.orchestrator.get(
    `/api/agent-runs/${encodeURIComponent(runId)}?${qs.toString()}`,
    { headers: { Accept: "application/json" } },
  );
  if (res.status === 403) return fail("FORBIDDEN", "Your role cannot use background runs.");
  if (res.status === 404) return fail("NOT_FOUND", `No background run "${runId}" of yours.`);
  if (!res.ok) return fail("AGENT_RUN_GET_FAILED", `orchestrator returned ${res.status}`);
  const r = (await res.json()) as RunItem;
  const summary = r.summary ?? (r.result ? r.result.slice(0, 2000) : null);
  return {
    ok: true,
    data: {
      id: r.id,
      title: r.title || r.goal.slice(0, 120),
      status: r.status,
      steps: `${r.iteration}/${r.maxIter}`,
      createdAt: r.createdAt,
      endedAt: r.endedAt,
      ...(typeof r.queuePosition === "number" ? { queuePosition: r.queuePosition } : {}),
      ...(r.waitingFor && r.waitingFor !== "none" ? { waitingFor: r.waitingFor } : {}),
      ...(r.error ? { error: r.error } : {}),
      ...(summary ? { summary } : {}),
      ...(r.artifacts?.length ? { artifacts: r.artifacts } : {}),
      ...(r.status === "awaiting_confirmation" && r.pending
        ? { needsApproval: { tool: r.pending.tool, summary: r.pending.summary } }
        : {}),
    },
  };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) {
    return fail("NO_PRINCIPAL", "This tool needs to know who it acts for, and does not.");
  }
  const runId = typeof args.run_id === "string" ? args.run_id.trim() : "";
  if (runId) return oneRun(runId, ctx, ctx.userId);
  const qs = new URLSearchParams({ onBehalfOf: ctx.userId });
  const limit =
    typeof args.limit === "number" && Number.isInteger(args.limit) && args.limit > 0
      ? Math.min(args.limit, 50)
      : 10;
  qs.set("limit", String(limit));
  if (typeof args.status === "string" && (STATUSES as readonly string[]).includes(args.status)) {
    qs.set("status", args.status);
  }
  if (args.this_chat === true) {
    if (!ctx.conversationId) return fail("NO_CONVERSATION", "This turn is not part of a saved conversation.");
    qs.set("sessionId", ctx.conversationId);
  }
  const res = await ctx.http.orchestrator.get(`/api/agent-runs?${qs.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 403) return fail("FORBIDDEN", "Your role cannot use background runs.");
  if (!res.ok) return fail("AGENT_RUN_LIST_FAILED", `orchestrator returned ${res.status}`);
  const body = (await res.json()) as { items?: RunItem[] };
  const runs = (body.items ?? []).map((r) => ({
    id: r.id,
    ...(r.title ? { title: r.title } : {}),
    goal: r.goal,
    status: r.status,
    createdAt: r.createdAt,
    endedAt: r.endedAt,
    steps: `${r.iteration}/${r.maxIter}`,
    ...(r.workspaceId ? { workspace: r.workspaceId } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.result ? { resultPreview: r.result.slice(0, 300) } : {}),
    ...(r.status === "awaiting_confirmation" && r.pending
      ? { needsApproval: { tool: r.pending.tool, since: r.pending.parkedAt } }
      : {}),
  }));
  return { ok: true, data: { runs, count: runs.length } };
}

const listAgentRuns: Tool = {
  name: "list_agent_runs",
  description:
    "Your background runs, newest first: state, steps, result, any approval awaited. Use when the user asks; never loop on it, results reach the chat by themselves.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default listAgentRuns;
