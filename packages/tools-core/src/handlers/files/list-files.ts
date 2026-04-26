import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Directory path to list. Defaults to '/'." },
  },
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = typeof args.path === "string" && args.path.length > 0 ? args.path : "/";
  const headers: Record<string, string> = {};
  if (ctx.ncToken) headers["X-Nextcloud-Token"] = ctx.ncToken;
  const res = await ctx.http.nextcloud.get(path, { headers });
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "LIST_FAILED", message: `nextcloud returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "list_files",
  description:
    "List files and directories at a path on the Droplet device's Nextcloud storage. Defaults to '/'.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
