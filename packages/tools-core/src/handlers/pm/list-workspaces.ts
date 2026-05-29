import type { Tool, ToolContext, ToolResult } from "../../types.js";

import { listWorkspaces, PlaneApiError } from "./pm-client.js";

const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

async function handler(_args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
  try {
    const workspaces = await listWorkspaces();
    return { ok: true, data: { workspaces } };
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
  name: "pm_list_workspaces",
  description:
    "List Plane workspaces visible to this Droplet. Each workspace has a slug used in downstream pm_* calls. Read-only.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
