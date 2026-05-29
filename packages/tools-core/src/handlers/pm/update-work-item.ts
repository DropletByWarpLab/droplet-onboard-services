import type { Tool, ToolContext, ToolResult } from "../../types.js";

import { updateWorkItem, PlaneApiError } from "./pm-client.js";

const inputSchema = {
  type: "object",
  properties: {
    workspace_slug: { type: "string" },
    project_id: { type: "string" },
    work_item_id: { type: "string" },
    name: { type: "string" },
    description_html: { type: "string" },
    assignees: { type: "array", items: { type: "string" } },
    labels: { type: "array", items: { type: "string" } },
  },
  required: ["workspace_slug", "project_id", "work_item_id"],
  additionalProperties: false,
} as const;

interface Args {
  workspace_slug: string;
  project_id: string;
  work_item_id: string;
  name?: string;
  description_html?: string;
  assignees?: string[];
  labels?: string[];
}

async function handler(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
  const { workspace_slug, project_id, work_item_id, ...fields } = args as unknown as Args;
  try {
    const work_item = await updateWorkItem(
      workspace_slug,
      project_id,
      work_item_id,
      fields,
    );
    return { ok: true, data: { work_item } };
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
  name: "pm_update_work_item",
  description:
    "Update fields on a Plane work item (name, description, assignees, labels). Requires confirmation. Returns the updated work item.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
