import type { Tool, ToolContext, ToolResult } from "../../types.js";

import { listWorkspaces, PlaneApiError } from "./pm-client.js";
import { mapPlaneAuthError } from "./pm-errors.js";

const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  // WARP-860 — Plane CE v0.24.1 has NO /api/v1/workspaces/ endpoint
  // (live-probed 404). The orchestrator resolves the list via Plane's
  // session app API and injects it through `_meta.pmWorkspaces`; prefer
  // that over an HTTP call that can only fail on CE.
  if (Array.isArray(ctx.pmWorkspaces) && ctx.pmWorkspaces.length > 0) {
    return { ok: true, data: { workspaces: ctx.pmWorkspaces } };
  }
  try {
    const workspaces = await listWorkspaces(ctx.pmApiKey);
    return { ok: true, data: { workspaces } };
  } catch (err) {
    const auth = mapPlaneAuthError(err);
    if (auth) return auth;
    if (err instanceof PlaneApiError) {
      return {
        ok: false,
        status: "error",
        error: {
          code: "PM_API_ERROR",
          message:
            "Plane CE has no /api/v1 workspace list and the orchestrator " +
            `did not inject one (upstream: ${err.message})`,
        },
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
