import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { validateNcPath } from "./_paths.js";

const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Full path to the file or directory." },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId || !ctx.ncToken) return err("AUTH_REQUIRED", "auth_required");
  const v = validateNcPath(args.path);
  if (!v.ok) return err("INVALID_PATH", v.error);
  if (v.path === "/") return err("INVALID_PATH", "refusing to delete root");
  const headers: Record<string, string> = {
    "X-Nextcloud-Token": ctx.ncToken,
    "X-Nextcloud-User": ctx.userId,
  };
  const res = await ctx.http.nextcloud.delete(
    `/files?path=${encodeURIComponent(v.path)}`,
    { headers },
  );
  if (!res.ok) return err("DELETE_FAILED", `nextcloud returned ${res.status}`);
  return { ok: true, data: { deleted: v.path } };
}

const tool: Tool = {
  name: "delete_file",
  description:
    "Delete a file or directory in the user's Nextcloud (moved to Nextcloud trash, restorable from the dashboard). Recursive for directories.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
