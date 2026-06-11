import type { Tool, ToolContext, ToolResult } from "../../types.js";

import { listWorkItems, PlaneApiError } from "./pm-client.js";
import { mapPlaneAuthError } from "./pm-errors.js";

const inputSchema = {
  type: "object",
  properties: {
    workspace_slug: { type: "string" },
    project_id: { type: "string" },
    state: { type: "string", description: "Optional state filter (state id)" },
    assignee: { type: "string", description: "Optional assignee filter (user id)" },
    per_page: { type: "number", minimum: 1, maximum: 100 },
  },
  required: ["workspace_slug", "project_id"],
  additionalProperties: false,
} as const;

interface Args {
  workspace_slug: string;
  project_id: string;
  state?: string;
  assignee?: string;
  per_page?: number;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { workspace_slug, project_id, state, assignee, per_page } = args as unknown as Args;
  try {
    const work_items = await listWorkItems(
      workspace_slug,
      project_id,
      {
        perPage: per_page,
        state,
        assignee,
      },
      ctx.pmApiKey,
    );
    return { ok: true, data: { work_items } };
  } catch (err) {
    const auth = mapPlaneAuthError(err);
    if (auth) return auth;
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
  name: "pm_list_work_items",
  description:
    "List work items (Plane's name for issues/tickets) under a project. Optional filters on state and assignee. Page size capped at 100. Read-only.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
