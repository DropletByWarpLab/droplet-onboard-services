import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  // WARP-867: Plane CE's /api/v1/ has no workspace list — the orchestrator
  // proxies it over the session app API (GET /api/pm/workspaces).
  const res = await ctx.http.orchestrator.get("/api/pm/workspaces", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return {
      ok: false,
      status: "error",
      error: {
        code: "PM_API_ERROR",
        message: body.error ?? `orchestrator returned ${res.status}`,
      },
    };
  }
  const data = (await res.json()) as { workspaces: unknown[] };
  return { ok: true, data: { workspaces: data.workspaces ?? [] } };
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
