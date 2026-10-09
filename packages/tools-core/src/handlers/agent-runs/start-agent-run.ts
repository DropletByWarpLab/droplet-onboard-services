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
    title: { type: "string", description: "Label, <60 chars." },
    goal: { type: "string", description: "What to do, in plain words." },
    deliverable: { type: "string", description: "The expected result." },
    constraints: { type: "string", description: "Limits to respect." },
    refs: {
      type: "array",
      items: { type: "string" },
      description: "Files or ids to start from.",
    },
    max_iter: {
      type: "integer",
      minimum: 1,
      description: "Step budget.",
    },
    workspace: { type: "string", description: "Workshop workspace id: build an extension there." },
    brief: { type: "string", description: "app-setup for hosting." },
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
  // WARP-3299 — constraints and references ride in the goal text: the run
  // reads its goal as its brief, and they bound what it works on.
  const constraints = typeof args.constraints === "string" ? args.constraints.trim() : "";
  const refs = Array.isArray(args.refs)
    ? args.refs.filter((r): r is string => typeof r === "string" && r.trim().length > 0).map((r) => r.trim())
    : [];
  const brief = [
    goal,
    ...(constraints ? [`Constraints: ${constraints}`] : []),
    ...(refs.length ? [`Start from: ${refs.join(", ")}`] : []),
  ].join("\n\n").slice(0, 4000);
  const body: Record<string, unknown> = { goal: brief, onBehalfOf: ctx.userId };
  if (args.brief !== undefined) {
    if (args.brief !== "app-setup" || !args.workspace || !ctx.conversationId) return fail("INVALID_ARGS", "app-setup needs a workspace and this chat.");
    body.brief = args.brief;
  }
  const title = typeof args.title === "string" ? args.title.trim().slice(0, 120) : "";
  if (title) body.title = title;
  const deliverable = typeof args.deliverable === "string" ? args.deliverable.trim().slice(0, 1000) : "";
  if (deliverable) body.deliverable = deliverable;
  // WARP-3299 — link the run to the chat turn that started it. From the
  // server-set context only (`_meta`, stdio-trusted), never from arguments.
  if (ctx.conversationId) {
    body.origin = "chat";
    body.sessionId = ctx.conversationId;
    if (ctx.messageId) body.originMessageId = ctx.messageId;
    if (ctx.toolCallId) body.originToolCallId = ctx.toolCallId;
  }
  if (typeof args.max_iter === "number" && Number.isInteger(args.max_iter) && args.max_iter > 0) {
    body.maxIter = args.max_iter;
  }
  // WARP-2896 — a workshop run. The route checks the workspace exists, is
  // active and idle; the id grammar is checked here so a typo is a legible
  // refusal rather than a 400 the model cannot read.
  const workspace = typeof args.workspace === "string" ? args.workspace.trim() : "";
  if (workspace) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(workspace)) {
      return fail("INVALID_ARGS", "workspace must be a workspace id (lowercase letters, digits, dashes)");
    }
    body.workspaceId = workspace;
  }
  const res = await ctx.http.orchestrator.post("/api/agent-runs", body, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 403) return fail("FORBIDDEN", "Your role cannot start background runs.");
  if (res.status === 429) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail("AGENT_RUN_CAP", err?.error ?? "You have too many background runs going. Wait for one to finish.");
  }
  if (res.status === 404 && workspace) return fail("NOT_FOUND", `No workspace "${workspace}" on this box.`);
  if (res.status === 409 && workspace) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail("WORKSPACE_BUSY", err?.error ?? `Workspace "${workspace}" cannot take a run right now.`);
  }
  if (!res.ok) return fail("AGENT_RUN_START_FAILED", `orchestrator returned ${res.status}`);
  const data = (await res.json()) as {
    id: string;
    status: string;
    workspaceId?: string | null;
    queuePosition?: number;
  };
  return {
    ok: true,
    data: {
      runId: data.id,
      status: data.status,
      ...(typeof data.queuePosition === "number" ? { queuePosition: data.queuePosition } : {}),
      ...(data.workspaceId ? { workspace: data.workspaceId } : {}),
      message: data.workspaceId
        ? "Started in the Workshop. You will be notified when it proposes its extension, or if it needs your approval for an action."
        : "Started in the background. You will be notified when it finishes, or if it needs your approval for an action.",
    },
  };
}

const startAgentRun: Tool = {
  name: "start_agent_run",
  description:
    "Run a task too long for one reply; result posts here. Call directly: the person approves a card, never text. Workspace brief app-setup configures hosting.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default startAgentRun;
