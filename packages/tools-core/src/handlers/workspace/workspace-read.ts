/**
 * WARP-2896 — `workspace_read`: one file, or one directory listing, from
 * the run's workspace. Tier-1. Paths are relative to the workspace root;
 * the route and the sandbox both refuse anything that would leave it.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { bind, fail, isRefusal, relayError } from "./_shared.js";

const inputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "File or directory, relative to the workspace root. \".\" lists the root.",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const bound = bind(ctx);
  if (isRefusal(bound)) return bound;
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (!path) return fail("INVALID_ARGS", "path is required");
  const res = await ctx.http.orchestrator.post(
    `/api/workspace/${encodeURIComponent(bound.workspace)}/read`,
    { path, onBehalfOf: ctx.userId },
    { headers: bound.headers },
  );
  if (!res.ok) return relayError(res, "read the workspace");
  const data = (await res.json()) as
    | { kind: "file"; path: string; content: string; bytes: number; truncated: boolean }
    | { kind: "directory"; path: string; entries: string[]; truncated: boolean };
  if (data.kind === "directory") {
    return { ok: true, data: { path: data.path, kind: "directory", entries: data.entries, truncated: data.truncated } };
  }
  return {
    ok: true,
    data: {
      path: data.path,
      kind: "file",
      content: data.content,
      bytes: data.bytes,
      ...(data.truncated ? { truncated: true, note: "The file is longer than what is shown." } : {}),
    },
  };
}

const workspaceRead: Tool = {
  name: "workspace_read",
  description:
    "Read a file, or list a directory, in this run's workspace. Paths are relative to the workspace root; use \".\" to list it.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default workspaceRead;
