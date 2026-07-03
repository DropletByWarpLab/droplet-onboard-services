import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId || !ctx.ncToken) {
    return {
      ok: false,
      status: "error",
      error: { code: "AUTH_REQUIRED", message: "user must be authenticated" },
    };
  }
  // WARP-1012: the `_service:mcp` principal must assert the acting user
  // via X-Nextcloud-User on every files-API call (same pair list_files
  // sends) — the orchestrator route's getUser() hard-rejects the service
  // principal without it, which surfaced live as "nextcloud returned 401".
  const headers: Record<string, string> = {
    "X-Nextcloud-Token": ctx.ncToken,
    "X-Nextcloud-User": ctx.userId,
  };
  const res = await ctx.http.nextcloud.get("/recents?limit=30", { headers });
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "RECENT_FAILED", message: `nextcloud returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "list_recent_files",
  description: "List the 30 most recently modified files across the user's Nextcloud.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
