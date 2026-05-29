import type { Tool, ToolContext, ToolResult } from "../../types.js";

import { transitionWorkItem, PlaneApiError } from "./pm-client.js";

const inputSchema = {
  type: "object",
  properties: {
    workspace_slug: { type: "string" },
    project_id: { type: "string" },
    work_item_id: { type: "string" },
    state_id: { type: "string", description: "Target state id (e.g. 'in_progress', 'done')" },
  },
  required: ["workspace_slug", "project_id", "work_item_id", "state_id"],
  additionalProperties: false,
} as const;

interface Args {
  workspace_slug: string;
  project_id: string;
  work_item_id: string;
  state_id: string;
}

async function handler(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
  const { workspace_slug, project_id, work_item_id, state_id } = args as unknown as Args;
  try {
    const work_item = await transitionWorkItem(
      workspace_slug,
      project_id,
      work_item_id,
      state_id,
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
  name: "pm_transition_work_item",
  description:
    "Transition a Plane work item to a different state (e.g. in_progress → done). Requires confirmation. Returns the updated work item.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
