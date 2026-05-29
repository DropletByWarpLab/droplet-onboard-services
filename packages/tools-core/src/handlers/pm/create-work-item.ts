import type { Tool, ToolContext, ToolResult } from "../../types.js";

import { createWorkItem, PlaneApiError } from "./pm-client.js";

const inputSchema = {
  type: "object",
  properties: {
    workspace_slug: { type: "string" },
    project_id: { type: "string" },
    name: { type: "string", minLength: 1, description: "Title of the work item" },
    description_html: { type: "string", description: "Optional HTML body" },
    assignees: {
      type: "array",
      items: { type: "string" },
      description: "User ids to assign",
    },
    labels: {
      type: "array",
      items: { type: "string" },
      description: "Label ids to apply",
    },
  },
  required: ["workspace_slug", "project_id", "name"],
  additionalProperties: false,
} as const;

interface Args {
  workspace_slug: string;
  project_id: string;
  name: string;
  description_html?: string;
  assignees?: string[];
  labels?: string[];
}

async function handler(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
  const { workspace_slug, project_id, name, description_html, assignees, labels } =
    args as unknown as Args;
  try {
    const work_item = await createWorkItem(workspace_slug, project_id, {
      name,
      description_html,
      assignees,
      labels,
    });
    return { ok: true, data: { work_item } };
  } catch (err) {
    if (err instanceof PlaneApiError) {
      return {
        ok: false,
        status: "error",
        error: { code: "PM_API_ERROR", message: err.message },
      };
    }
    throw err;
  }
}

const tool: Tool = {
  name: "pm_create_work_item",
  description:
    "Create a Plane work item (issue) under a project. Requires confirmation. Returns the created work item with its id.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
