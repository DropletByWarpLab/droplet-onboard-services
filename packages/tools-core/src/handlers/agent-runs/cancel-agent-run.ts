/**
 * WARP-3302 — `cancel_agent_run`: stop one of the person's background runs
 * (epic WARP-3298).
 *
 * A WRITE WITHOUT A PROMPT, ON PURPOSE. Cancelling only stops work: a queued
 * or parked run ends at once, a running one at its next heartbeat, and every
 * step it already completed stays done (`cancelAgentRun`). Nothing is deleted
 * and nothing irreversible happens, so it sits with the other non-destructive
 * writes rather than behind the Tier-2 thumbs-up — the person asked to stop,
 * and a second prompt to stop would be the product arguing with them. It is
 * still `requiresWrite`, so roles that lose writes (family/guest) never get it.
 *
 * WHO. Owner-scoped by the route exactly like `list_agent_runs`: another
 * user's run is a 404. A run may not cancel runs; the worker keeps this tool
 * out of every run's pool (RUN_EXCLUDED_TOOLS).
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    run_id: { type: "string" },
  },
  required: ["run_id"],
  additionalProperties: false,
} as const;

function fail(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const runId = typeof args.run_id === "string" ? args.run_id.trim() : "";
  if (!runId) return fail("INVALID_ARGS", "run_id is required");
  if (ctx.agentRunId) {
    return fail("AGENT_RUN_RECURSION_REFUSED", "A background run cannot stop background runs.");
  }
  if (!ctx.userId) {
    return fail("NO_PRINCIPAL", "This tool needs to know who it acts for, and does not.");
  }
  const res = await ctx.http.orchestrator.post(
    `/api/agent-runs/${encodeURIComponent(runId)}/cancel`,
    { onBehalfOf: ctx.userId },
    { headers: { Accept: "application/json" } },
  );
  if (res.status === 403) return fail("FORBIDDEN", "Your role cannot use background runs.");
  if (res.status === 404) return fail("NOT_FOUND", `No background run "${runId}" of yours.`);
  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as { status?: string } | null;
    return fail("ALREADY_FINISHED", `That run already ended${body?.status ? ` (${body.status})` : ""}.`);
  }
  if (!res.ok) return fail("AGENT_RUN_CANCEL_FAILED", `orchestrator returned ${res.status}`);
  return {
    ok: true,
    data: {
      runId,
      status: "cancelled",
      message: "Stopped. Steps it already completed stay done.",
    },
  };
}

const cancelAgentRun: Tool = {
  name: "cancel_agent_run",
  description:
    "Stop one of the user's background runs when they ask. Completed steps stay done.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default cancelAgentRun;
