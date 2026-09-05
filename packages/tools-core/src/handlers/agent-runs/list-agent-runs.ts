/**
 * WARP-2180 — `list_agent_runs`: the person's background runs, newest
 * first (epic WARP-2176). Read-only; the orchestrator route scopes the list
 * to the person this turn acts for, so the model can never see another
 * user's runs. A run parked on a Tier-2 call shows what it is waiting for.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const STATUSES = ["queued", "running", "awaiting_confirmation", "succeeded", "failed", "cancelled"] as const;

const inputSchema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: [...STATUSES],
      description: "Only runs in this state. Omit for all.",
    },
    limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 10." },
  },
  additionalProperties: false,
} as const;

interface RunItem {
  id: string;
  goal: string;
  status: string;
  createdAt: string;
  endedAt: string | null;
  iteration: number;
  maxIter: number;
  error: string | null;
  result: string | null;
  pending: { tool: string; parkedAt: string | null } | null;
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) {
    return fail("NO_PRINCIPAL", "This tool needs to know who it acts for, and does not.");
  }
  const qs = new URLSearchParams({ onBehalfOf: ctx.userId });
  const limit =
    typeof args.limit === "number" && Number.isInteger(args.limit) && args.limit > 0
      ? Math.min(args.limit, 50)
      : 10;
  qs.set("limit", String(limit));
  if (typeof args.status === "string" && (STATUSES as readonly string[]).includes(args.status)) {
    qs.set("status", args.status);
  }
  const res = await ctx.http.orchestrator.get(`/api/agent-runs?${qs.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 403) return fail("FORBIDDEN", "Your role cannot use background runs.");
  if (!res.ok) return fail("AGENT_RUN_LIST_FAILED", `orchestrator returned ${res.status}`);
  const body = (await res.json()) as { items?: RunItem[] };
  const runs = (body.items ?? []).map((r) => ({
    id: r.id,
    goal: r.goal,
    status: r.status,
    createdAt: r.createdAt,
    endedAt: r.endedAt,
    steps: `${r.iteration}/${r.maxIter}`,
    ...(r.error ? { error: r.error } : {}),
    ...(r.result ? { resultPreview: r.result.slice(0, 300) } : {}),
    ...(r.pending ? { needsApproval: { tool: r.pending.tool, since: r.pending.parkedAt } } : {}),
  }));
  return { ok: true, data: { runs, count: runs.length } };
}

const listAgentRuns: Tool = {
  name: "list_agent_runs",
  description:
    "List your background runs, newest first, with their state, step count, a result preview, and any action a run is waiting on you to approve.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default listAgentRuns;
