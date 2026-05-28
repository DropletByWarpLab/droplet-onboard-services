/**
 * WARP-466 (D2) — `email_read` LLM tool.
 *
 * Fetch the full thread (with ordered messages) for a given thread id.
 * Read tier.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    accountId: {
      type: "string",
      description: "EmailAccount.id the thread belongs to.",
    },
    threadId: {
      type: "string",
      description: "EmailThread.id to fetch.",
    },
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
    `/api/email/${encodeURIComponent(accountId)}/threads/${encodeURIComponent(threadId)}`,
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
        code: "EMAIL_READ_FAILED",
        message: `orchestrator returned ${res.status}`,
      },
    };
  }
  const data = (await res.json()) as Record<string, unknown>;
  return {
    ok: true,
    data: { type: "email_thread", ...data },
  };
}

const tool: Tool = {
  name: "email_read",
  description:
    "Fetch the full content of an email thread — subject, sender, snippet, and every message in order. Use when the user asks to open / read / show a specific thread.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
