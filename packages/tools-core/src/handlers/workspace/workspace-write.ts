/**
 * WARP-2896 — `workspace_write`: create or replace one file in the run's
 * workspace. A write, no confirmation: its blast radius is one checkout on
 * the internal-only sandbox, and the run's pool admits it on exactly that
 * ground (agent-run-worker WORKSPACE_TOOLS). IDEMPOTENT — the same bytes
 * twice is one state, and the answer says whether anything changed — so
 * the worker may re-dispatch it after a lost result.
 *
 * Nothing is committed here. `workspace_commit` records the state.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { bind, fail, isRefusal, relayError } from "./_shared.js";

const inputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "The file to write, relative to the workspace root. Missing directories are created.",
    },
    content: {
      type: "string",
      description: "The whole file. There is no partial edit: read, change, write the full text back.",
    },
  },
  required: ["path", "content"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const bound = bind(ctx);
  if (isRefusal(bound)) return bound;
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (!path) return fail("INVALID_ARGS", "path is required");
  if (typeof args.content !== "string") return fail("INVALID_ARGS", "content must be a string");
  const res = await ctx.http.orchestrator.post(
    `/api/workspace/${encodeURIComponent(bound.workspace)}/write`,
    { path, content: args.content, onBehalfOf: ctx.userId },
    { headers: bound.headers },
  );
  if (!res.ok) return relayError(res, "write to the workspace");
  const data = (await res.json()) as { path: string; bytes: number; changed: boolean };
  return {
    ok: true,
    data: {
      path: data.path,
      bytes: data.bytes,
      changed: data.changed,
      message: data.changed ? `Wrote ${data.path} (${data.bytes} bytes). Not committed yet.` : `${data.path} already had that content.`,
    },
  };
}

const workspaceWrite: Tool = {
  name: "workspace_write",
  description:
    "Create or replace one file in this run's workspace with the full text given. Not committed until workspace_commit.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default workspaceWrite;
