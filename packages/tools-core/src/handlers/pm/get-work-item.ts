import type { Tool, ToolContext, ToolResult } from "../../types.js";

import { getWorkItem, PlaneApiError } from "./pm-client.js";
import { mapPlaneAuthError } from "./pm-errors.js";

const inputSchema = {
  type: "object",
  properties: {
    workspace_slug: { type: "string" },
    project_id: { type: "string" },
    work_item_id: { type: "string" },
  },
  required: ["workspace_slug", "project_id", "work_item_id"],
  additionalProperties: false,
} as const;

interface Args {
  workspace_slug: string;
  project_id: string;
  work_item_id: string;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { workspace_slug, project_id, work_item_id } = args as unknown as Args;
  try {
    const work_item = await getWorkItem(
      workspace_slug,
      project_id,
      work_item_id,
      ctx.pmApiKey,
    );
    return { ok: true, data: { work_item } };
  } catch (err) {
    const auth = mapPlaneAuthError(err);
    if (auth) return auth;
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
  name: "pm_get_work_item",
  description:
    "Fetch a single work item by id, including description and metadata. Returns 404 as PM_WORK_ITEM_NOT_FOUND. Read-only.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
