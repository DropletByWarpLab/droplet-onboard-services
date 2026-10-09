/**
 * WARP-2896 — `workspace_diff`: what has changed. Tier-1. Without `base`,
 * the uncommitted changes against HEAD (new files included); with one, the
 * commits since that ref.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { bind, fail, isRefusal, relayError } from "./_shared.js";

const inputSchema = {
  type: "object",
  properties: {
    base: {
      type: "string",
      description: "Commit/tag; omit for uncommitted changes.",
    },
  },
  required: [],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const bound = bind(ctx);
  if (isRefusal(bound)) return bound;
  const base = typeof args.base === "string" && args.base.trim() ? args.base.trim() : undefined;
  const res = await ctx.http.orchestrator.post(
    `/api/workspace/${encodeURIComponent(bound.workspace)}/diff`,
    { ...(base ? { base } : {}), onBehalfOf: ctx.userId },
    { headers: bound.headers },
  );
  if (!res.ok) return relayError(res, "diff the workspace");
  const data = (await res.json()) as { base: string; diff: string; truncated: boolean };
  return {
    ok: true,
    data: {
      base: data.base,
      diff: data.diff,
      empty: data.diff.trim().length === 0,
      ...(data.truncated ? { truncated: true } : {}),
    },
  };
}

const workspaceDiff: Tool = {
  name: "workspace_diff",
  description:
    "Show workspace edits: uncommitted by default, or changes since base.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default workspaceDiff;
