import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch, OrchPmError, toPlaneProject } from "./pm-orch.js";

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
  const url = `/api/pm/projects?workspace=${encodeURIComponent(workspace_slug)}${per_page !== undefined ? `&per_page=${per_page}` : ""}`;
  try {
    const data = await callOrch<{ projects?: Parameters<typeof toPlaneProject>[0][] }>(
      ctx,
      "get",
      url,
    );
    return { ok: true, data: { projects: (data.projects ?? []).map(toPlaneProject) } };
  } catch (err) {
    if (err instanceof OrchPmError) {
      return { ok: false, status: "error", error: { code: "PM_API_ERROR", message: err.message } };
    }
    throw err;
  }
}

const tool: Tool = {
  name: "pm_list_projects",
  description:
    "List projects under a workspace. Returns project id, name, identifier, and parent workspace. Read-only.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
