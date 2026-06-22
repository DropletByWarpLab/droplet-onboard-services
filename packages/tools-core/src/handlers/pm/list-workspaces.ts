import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch, OrchPmError, type PlaneWorkspace } from "./pm-orch.js";

const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    const data = await callOrch<{ workspaces?: PlaneWorkspace[] }>(ctx, "get", "/api/pm/workspaces");
    return { ok: true, data: { workspaces: data.workspaces ?? [] } };
  } catch (err) {
    if (err instanceof OrchPmError) {
      return { ok: false, status: "error", error: { code: "PM_API_ERROR", message: err.message } };
    }
    throw err;
  }
}

const tool: Tool = {
  name: "pm_list_workspaces",
  description:
    "List the project workspaces on this Droplet. Each workspace has a slug used in downstream pm_* calls. Read-only.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
