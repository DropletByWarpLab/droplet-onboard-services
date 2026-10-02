/**
 * WARP-2896 — `workspace_search`: `git grep` over the run's workspace.
 * Tier-1. Committed and tracked files only — a file written but not yet
 * committed is found by reading it, not by searching.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { bind, fail, isRefusal, relayError } from "./_shared.js";

const inputSchema = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description: "A regular expression (git grep syntax) to search for.",
    },
    glob: {
      type: "string",
      description: "Optional path pattern to limit the search, e.g. src/*.ts.",
    },
  },
  required: ["pattern"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const bound = bind(ctx);
  if (isRefusal(bound)) return bound;
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  if (!pattern.trim()) return fail("INVALID_ARGS", "pattern is required");
  const glob = typeof args.glob === "string" && args.glob.trim() ? args.glob.trim() : undefined;
  const res = await ctx.http.orchestrator.post(
    `/api/workspace/${encodeURIComponent(bound.workspace)}/search`,
    { pattern, ...(glob ? { glob } : {}), onBehalfOf: ctx.userId },
    { headers: bound.headers },
  );
  if (!res.ok) return relayError(res, "search the workspace");
  const data = (await res.json()) as { hits: Array<{ path: string; line: number; text: string }>; truncated: boolean };
  return { ok: true, data: { pattern, hits: data.hits, count: data.hits.length, truncated: data.truncated } };
}

const workspaceSearch: Tool = {
  name: "workspace_search",
  description:
    "Search the tracked files of this run's workspace with a regular expression. Returns matching lines with file and line number.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default workspaceSearch;
