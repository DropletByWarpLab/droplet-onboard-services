/**
 * WARP-2896 — `workspace_commit`: record everything changed as one commit,
 * authored as the person the run acts for, and push it to the box's store
 * (the backed-up half). A write without confirmation on the same ground as
 * `workspace_write`. Nothing to commit is not an error: the answer carries
 * `changed: false` and the current head — which is also what makes a
 * re-dispatch after a lost result harmless.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { bind, fail, isRefusal, relayError } from "./_shared.js";

const inputSchema = {
  type: "object",
  properties: {
    message: {
      type: "string",
      description: "The commit message: what changed and why, one line first.",
    },
  },
  required: ["message"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const bound = bind(ctx);
  if (isRefusal(bound)) return bound;
  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!message) return fail("INVALID_ARGS", "message is required");
  const res = await ctx.http.orchestrator.post(
    `/api/workspace/${encodeURIComponent(bound.workspace)}/commit`,
    { message, onBehalfOf: ctx.userId },
    { headers: bound.headers },
  );
  if (!res.ok) return relayError(res, "commit to the workspace");
  const data = (await res.json()) as { commit: string; changed: boolean };
  return {
    ok: true,
    data: {
      commit: data.commit.slice(0, 12),
      changed: data.changed,
      message: data.changed ? `Committed ${data.commit.slice(0, 12)}.` : "Nothing to commit; the workspace is clean.",
    },
  };
}

const workspaceCommit: Tool = {
  name: "workspace_commit",
  description:
    "Commit every change in this run's workspace with the given message, as the person the run acts for.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default workspaceCommit;
