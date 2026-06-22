import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch, OrchPmError, toPlaneWorkItem } from "./pm-orch.js";

const inputSchema = {
  type: "object",
  properties: {
    workspace_slug: { type: "string" },
    query: { type: "string", minLength: 1 },
    per_page: { type: "number", minimum: 1, maximum: 100 },
  },
  required: ["workspace_slug", "query"],
  additionalProperties: false,
} as const;

interface Args {
  workspace_slug: string;
  query: string;
  per_page?: number;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { workspace_slug, query, per_page } = args as unknown as Args;
  const params = new URLSearchParams({ workspace: workspace_slug, q: query });
  if (per_page) params.set("per_page", String(per_page));
  try {
    const data = await callOrch<{ work_items?: Parameters<typeof toPlaneWorkItem>[0][] }>(
      ctx,
      "get",
      `/api/pm/work-items?${params.toString()}`,
    );
    const items = (data.work_items ?? []).map(toPlaneWorkItem);
    return { ok: true, data: { work_items: per_page ? items.slice(0, per_page) : items } };
  } catch (err) {
    if (err instanceof OrchPmError) {
      return { ok: false, status: "error", error: { code: "PM_API_ERROR", message: err.message } };
    }
    throw err;
  }
}

const tool: Tool = {
  name: "pm_search_work_items",
  description:
    "Free-text search over work items in a project workspace. Returns up to 100 matches. Read-only.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
