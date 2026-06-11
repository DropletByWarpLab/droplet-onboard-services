import type { Tool, ToolContext, ToolResult } from "../../types.js";

import { searchWorkItems, PlaneApiError } from "./pm-client.js";
import { mapPlaneAuthError } from "./pm-errors.js";

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
  try {
    const work_items = await searchWorkItems(
      workspace_slug,
      query,
      per_page,
      ctx.pmApiKey,
    );
    return { ok: true, data: { work_items } };
  } catch (err) {
    const auth = mapPlaneAuthError(err);
    if (auth) return auth;
    if (err instanceof PlaneApiError) {
      // WARP-860 — Plane CE v0.24.1 has no /api/v1/workspaces/<slug>/search/
      // endpoint at all (live-probed 404). Name the gap instead of telling
      // the model the workspace doesn't exist.
      if (err.status === 404) {
        return {
          ok: false,
          status: "error",
          error: {
            code: "PM_SEARCH_UNAVAILABLE",
            message:
              "Plane CE has no /api/v1 workspace search endpoint — " +
              "use pm_list_work_items and filter client-side instead",
          },
        };
      }
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
