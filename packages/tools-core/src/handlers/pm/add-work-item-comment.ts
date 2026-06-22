import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch, OrchPmError } from "./pm-orch.js";

const inputSchema = {
  type: "object",
  properties: {
    workspace_slug: { type: "string" },
    project_id: { type: "string" },
    work_item_id: { type: "string" },
    comment_html: { type: "string", minLength: 1, description: "HTML body of the comment" },
  },
  required: ["workspace_slug", "project_id", "work_item_id", "comment_html"],
  additionalProperties: false,
} as const;

interface Args {
  workspace_slug: string;
  project_id: string;
  work_item_id: string;
  comment_html: string;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { work_item_id, comment_html } = args as unknown as Args;
  try {
    const data = await callOrch<{ comment: unknown }>(
      ctx,
      "post",
      `/api/pm/work-items/${encodeURIComponent(work_item_id)}/comments`,
      { comment_html },
    );
    return { ok: true, data: { comment: data.comment } };
  } catch (err) {
    if (err instanceof OrchPmError) {
      const code = err.status === 404 ? "PM_WORK_ITEM_NOT_FOUND" : "PM_API_ERROR";
      return { ok: false, status: "error", error: { code, message: err.message } };
    }
    throw err;
  }
}

const tool: Tool = {
  name: "pm_add_work_item_comment",
  description:
    "Append an HTML comment to a work item. Requires confirmation. Returns the new comment id.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
