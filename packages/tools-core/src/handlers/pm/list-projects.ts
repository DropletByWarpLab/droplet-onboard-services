import type { Tool, ToolContext, ToolResult } from "../../types.js";

import { listProjects, PlaneApiError } from "./pm-client.js";
import { mapPlaneAuthError } from "./pm-errors.js";

const inputSchema = {
  type: "object",
  properties: {
    workspace_slug: { type: "string", description: "Workspace slug from pm_list_workspaces" },
    per_page: { type: "number", minimum: 1, maximum: 100, description: "Page size, default 50" },
  },
  required: ["workspace_slug"],
  additionalProperties: false,
} as const;

interface Args {
  workspace_slug: string;
  per_page?: number;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { workspace_slug, per_page } = args as unknown as Args;
  try {
    const projects = await listProjects(workspace_slug, per_page, ctx.pmApiKey);
    return { ok: true, data: { projects } };
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
  name: "pm_list_projects",
  description:
    "List projects under a Plane workspace. Returns project id, name, identifier, and parent workspace. Read-only.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
