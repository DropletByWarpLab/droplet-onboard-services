import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch, OrchPmError, toPlaneWorkItem } from "./pm-orch.js";

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
  const { project_id, state, assignee, per_page } = args as unknown as Args;
  const params = new URLSearchParams();
  if (state) params.set("state", state);
  if (assignee) params.set("assignee", assignee);
  if (per_page) params.set("per_page", String(per_page));
  const qs = params.toString();
  try {
    const data = await callOrch<{ work_items?: Parameters<typeof toPlaneWorkItem>[0][] }>(
      ctx,
      "get",
      `/api/pm/projects/${encodeURIComponent(project_id)}/work-items${qs ? `?${qs}` : ""}`,
    );
    return { ok: true, data: { work_items: (data.work_items ?? []).map(toPlaneWorkItem) } };
  } catch (err) {
    if (err instanceof OrchPmError) {
      const code = err.status === 404 ? "PM_WORK_ITEM_NOT_FOUND" : "PM_API_ERROR";
      return { ok: false, status: "error", error: { code, message: err.message } };
    }
    throw err;
  }
}

const tool: Tool = {
  name: "pm_list_work_items",
  description:
    "List work items (issues/tickets) under a project. Optional filters on state and assignee. Page size capped at 100. Read-only.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
