import type { Tool, ToolContext, ToolResult } from "../../types.js";

import { searchWorkItems, PlaneApiError } from "./pm-client.js";

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

async function handler(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
  const { workspace_slug, query, per_page } = args as unknown as Args;
  try {
    const work_items = await searchWorkItems(workspace_slug, query, per_page);
    return { ok: true, data: { work_items } };
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
  name: "pm_search_work_items",
  description:
    "Free-text search over work items in a Plane workspace. Returns up to 100 matches. Read-only.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
