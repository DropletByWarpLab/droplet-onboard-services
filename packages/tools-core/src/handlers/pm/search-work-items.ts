import type { Tool, ToolContext, ToolResult } from "../../types.js";

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
  // WARP-867: Plane CE's /api/v1/ has no search — the orchestrator proxies
  // the app API's global search (GET /api/pm/search → results.issue).
  const params = new URLSearchParams({ workspace_slug, query });
  const res = await ctx.http.orchestrator.get(`/api/pm/search?${params.toString()}`, {
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
  const data = (await res.json()) as { work_items: unknown[] };
  const items = data.work_items ?? [];
  return {
    ok: true,
    data: { work_items: per_page ? items.slice(0, per_page) : items },
  };
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
