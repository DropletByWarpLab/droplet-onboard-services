import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch, OrchPmError, toPlaneWorkItem } from "./pm-orch.js";

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

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { project_id, name, description_html, assignees, labels } = args as unknown as Args;
  try {
    const data = await callOrch<{ work_item: Parameters<typeof toPlaneWorkItem>[0] }>(
      ctx,
      "post",
      `/api/pm/projects/${encodeURIComponent(project_id)}/work-items`,
      { name, description_html, assignees, label_ids: labels },
    );
    return { ok: true, data: { work_item: toPlaneWorkItem(data.work_item) } };
  } catch (err) {
    if (err instanceof OrchPmError) {
      return { ok: false, status: "error", error: { code: "PM_API_ERROR", message: err.message } };
    }
    throw err;
  }
}

const tool: Tool = {
  name: "pm_create_work_item",
  description:
    "Create a work item (issue) under a project. Requires confirmation. Returns the created work item with its id.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
