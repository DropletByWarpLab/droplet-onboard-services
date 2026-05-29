/**
 * WARP-466 (D2) — `email_search` LLM tool.
 *
 * Search persisted EmailThread / EmailMessage rows via the
 * orchestrator's `/api/email/:accountId/threads` filter surface.
 * Read tier — safe to call without confirmation.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    accountId: {
      type: "string",
      description: "EmailAccount.id to search inside.",
    },
    filter: {
      type: "string",
      enum: ["inbox", "triaged", "archived", "droplet"],
      description:
        "Tab to filter by. `droplet` returns threads with at least one Droplet-drafted reply (regardless of triage status).",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: "Max threads to return (default 20).",
    },
  },
  required: ["accountId"],
  additionalProperties: false,
} as const;

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const accountId = typeof args.accountId === "string" ? args.accountId : "";
  if (!accountId) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "accountId is required" },
    };
  }
  const filter =
    typeof args.filter === "string" ? args.filter : "inbox";
  const limit =
    typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.max(1, Math.min(100, Math.floor(args.limit)))
      : 20;
  const params = new URLSearchParams({ filter, limit: String(limit) });
  const res = await ctx.http.orchestrator.get(
    `/api/email/${encodeURIComponent(accountId)}/threads?${params.toString()}`,
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "EMAIL_SEARCH_FAILED",
        message: `orchestrator returned ${res.status}`,
      },
    };
  }
  const data = (await res.json()) as {
    filter: string;
    threads: Array<{
      id: string;
      subject: string;
      lastSender: string | null;
      snippet: string | null;
      lastMessageAt: string;
      triageStatus: string;
      draftedByDroplet: boolean;
    }>;
  };
  return {
    ok: true,
    data: {
      type: "email_search",
      filter: data.filter,
      threadCount: data.threads.length,
      threads: data.threads,
    },
  };
}

const tool: Tool = {
  name: "email_search",
  description:
    "List email threads in a given account, filtered by triage tab (inbox / triaged / archived) or by `droplet` to find threads with Droplet-drafted replies. Returns thread id + subject + last-sender + snippet for each match.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
