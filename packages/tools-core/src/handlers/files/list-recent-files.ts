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
  const headers: Record<string, string> = { "X-Nextcloud-Token": ctx.ncToken };
  const res = await ctx.http.nextcloud.get("/recent?limit=30", { headers });
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
