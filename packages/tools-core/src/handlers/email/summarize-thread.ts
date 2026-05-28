/**
 * WARP-466 (D2) — `email_summarize_thread` LLM tool.
 *
 * Returns the orchestrator's section 2.4 analysis card for a thread —
 * summary + callouts + suggested actions + related references. The
 * orchestrator route internally drives the agent loop; this tool is a
 * thin wrapper so chat (or another spec step) can fetch it without
 * duplicating retrieval.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    accountId: { type: "string" },
    threadId: { type: "string" },
  },
  required: ["accountId", "threadId"],
  additionalProperties: false,
} as const;

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const accountId = typeof args.accountId === "string" ? args.accountId : "";
  const threadId = typeof args.threadId === "string" ? args.threadId : "";
  if (!accountId || !threadId) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "INVALID_ARGS",
        message: "accountId and threadId are required",
      },
    };
  }
  const res = await ctx.http.orchestrator.get(
    `/api/email/${encodeURIComponent(accountId)}/threads/${encodeURIComponent(threadId)}/analysis`,
    { headers: { Accept: "application/json" } },
  );
  if (res.status === 404) {
    return {
      ok: false,
      status: "error",
      error: { code: "NOT_FOUND", message: "Thread not found" },
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "EMAIL_SUMMARIZE_FAILED",
        message: `orchestrator returned ${res.status}`,
      },
    };
  }
  const data = (await res.json()) as Record<string, unknown>;
  return {
    ok: true,
    data: { type: "email_analysis", ...data },
  };
}

const tool: Tool = {
  name: "email_summarize_thread",
  description:
    "Produce a structured analysis of an email thread for the §2.4 AI side panel: short summary, callouts (named entities, dates, asks), suggested actions (with safety tier), and related references (files / other threads / cameras / tools). Backed by the orchestrator's internal agent-loop analysis endpoint — no retrieval duplicated here.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
