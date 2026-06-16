import type { Tool, ToolContext, ToolResult } from "../../types.js";

import { addWorkItemComment, PlaneApiError } from "./pm-client.js";
import { ensurePlaneToken } from "./ensure-token.js";

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
  // WARP-867: inject the orchestrator-minted Plane service token before
  // the first /api/v1/ call (DROPLET_PM_ADMIN_TOKEN was never valid).
  await ensurePlaneToken(ctx);
  const { workspace_slug, project_id, work_item_id, comment_html } = args as unknown as Args;
  try {
    const comment = await addWorkItemComment(
      workspace_slug,
      project_id,
      work_item_id,
      comment_html,
    );
    return { ok: true, data: { comment } };
  } catch (err) {
    if (err instanceof PlaneApiError) {
      const code = err.status === 404 ? "PM_WORK_ITEM_NOT_FOUND" : "PM_API_ERROR";
      return {
        ok: false,
        status: "error",
        error: { code, message: err.message },
      };
    }
    throw err;
  }
}

const tool: Tool = {
  name: "pm_add_work_item_comment",
  description:
    "Append an HTML comment to a Plane work item. Requires confirmation. Returns the new comment id.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
