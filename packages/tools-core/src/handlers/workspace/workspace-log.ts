/**
 * WARP-2896 — `workspace_log`: the workspace's commits, newest first.
 * Tier-1.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { bind, fail, isRefusal, relayError } from "./_shared.js";

const inputSchema = {
  type: "object",
  properties: {
    limit: {
      type: "integer",
      minimum: 1,
      description: "How many commits, newest first. Default 20, at most 100.",
    },
  },
  required: [],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const bound = bind(ctx);
  if (isRefusal(bound)) return bound;
  const limit =
    typeof args.limit === "number" && Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 20;
  const res = await ctx.http.orchestrator.post(
    `/api/workspace/${encodeURIComponent(bound.workspace)}/log`,
    { limit, onBehalfOf: ctx.userId },
    { headers: bound.headers },
  );
  if (!res.ok) return relayError(res, "read the workspace history");
  const data = (await res.json()) as {
    entries: Array<{ commit: string; author: string; date: string; subject: string; refs: string[] }>;
  };
  return {
    ok: true,
    data: {
      commits: data.entries.map((e) => ({
        commit: e.commit.slice(0, 12),
        author: e.author,
        date: e.date,
        subject: e.subject,
        ...(e.refs.length > 0 ? { refs: e.refs } : {}),
      })),
      count: data.entries.length,
    },
  };
}

const workspaceLog: Tool = {
  name: "workspace_log",
  description:
    "List the commits in this run's workspace, newest first, with author, date and subject.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default workspaceLog;
