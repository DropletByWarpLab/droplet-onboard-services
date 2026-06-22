import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch, OrchPmError, toPlaneWorkItem } from "./pm-orch.js";

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

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { work_item_id, name, description_html, assignees, labels } = args as unknown as Args;
  try {
    const data = await callOrch<{ work_item: Parameters<typeof toPlaneWorkItem>[0] }>(
      ctx,
      "patch",
      `/api/pm/work-items/${encodeURIComponent(work_item_id)}`,
      { name, description_html, assignees, label_ids: labels },
    );
    return { ok: true, data: { work_item: toPlaneWorkItem(data.work_item) } };
  } catch (err) {
    if (err instanceof OrchPmError) {
      const code = err.status === 404 ? "PM_WORK_ITEM_NOT_FOUND" : "PM_API_ERROR";
      return { ok: false, status: "error", error: { code, message: err.message } };
    }
    throw err;
  }
}

const tool: Tool = {
  name: "pm_update_work_item",
  description:
    "Update fields on a work item (name, description, assignees, labels). Requires confirmation. Returns the updated work item.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
