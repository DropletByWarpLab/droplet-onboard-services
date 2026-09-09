/**
 * WARP-2180 — `start_agent_run`: hand Droplet a task to work on in the
 * background (epic WARP-2176).
 *
 * TIER-2 ON PURPOSE. A background run spends the box's compute unattended
 * for minutes, so starting one is confirmed like any other Tier-2 action —
 * the WARP-2305 interceptor challenges the first call and the person
 * approves it in chat. Yes, that means the very first thing a chat-started
 * run does is prompt; the ticket says to measure that before softening it,
 * and to soften it with an ADR, not a default flip.
 *
 * WHO. The orchestrator route attributes the run to the person this turn
 * acts for (`onBehalfOf` = `ctx.userId`, the same stdio-trusted identity
 * `_meta.userId` already carries) and checks THEIR role — a `family`
 * member cannot start a run from chat, and an `admin` who can gets a run
 * that reaches only what they reach. No privilege laundering by delegation.
 *
 * RECURSION. A run may not start a run: one prompt must not spawn a fleet
 * that saturates the model. The worker keeps this tool out of every run's
 * pool (structural); this check is the second line, for a caller that
 * reaches the handler some other way with `ctx.agentRunId` set.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    goal: {
      type: "string",
      description:
        "What to accomplish, in plain language. The run works on it unattended, with the same tools you have, and reports back when done.",
    },
    max_iter: {
      type: "integer",
      minimum: 1,
      description: "Optional step budget for the run.",
    },
  },
  required: ["goal"],
  additionalProperties: false,
} as const;

function fail(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const goal = typeof args.goal === "string" ? args.goal.trim() : "";
  if (!goal) return fail("INVALID_ARGS", "goal is required");
  if (ctx.agentRunId) {
    return fail(
      "AGENT_RUN_RECURSION_REFUSED",
      "A background run cannot start another background run. Finish this task here instead.",
    );
  }
  if (!ctx.userId) {
    return fail("NO_PRINCIPAL", "This tool needs to know who it acts for, and does not.");
  }
  const body: Record<string, unknown> = { goal, onBehalfOf: ctx.userId };
  if (typeof args.max_iter === "number" && Number.isInteger(args.max_iter) && args.max_iter > 0) {
    body.maxIter = args.max_iter;
  }
  const res = await ctx.http.orchestrator.post("/api/agent-runs", body, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 403) return fail("FORBIDDEN", "Your role cannot start background runs.");
  if (!res.ok) return fail("AGENT_RUN_START_FAILED", `orchestrator returned ${res.status}`);
  const data = (await res.json()) as { id: string; status: string };
  return {
    ok: true,
    data: {
      runId: data.id,
      status: data.status,
      message:
        "Started in the background. You will be notified when it finishes, or if it needs your approval for an action.",
    },
  };
}

const startAgentRun: Tool = {
  name: "start_agent_run",
  description:
    "Start a background run: Droplet works on a multi-step task unattended (minutes, not seconds) and notifies you when it finishes or needs your approval for an action. Use for jobs too long for one reply — sweeping files, reviewing many items. Needs your confirmation to start.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default startAgentRun;
