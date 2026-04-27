import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { validateNcPath } from "./_paths.js";

const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Full directory path." },
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
  if (v.path === "/") return err("INVALID_PATH", "cannot create root");
  const headers: Record<string, string> = {
    "X-Nextcloud-Token": ctx.ncToken,
    "X-Nextcloud-User": ctx.userId,
  };
  const res = await ctx.http.nextcloud.post("/mkdir", { path: v.path }, { headers });
  if (!res.ok) return err("MKDIR_FAILED", `nextcloud returned ${res.status}`);
  return { ok: true, data: { created: v.path } };
}

const tool: Tool = {
  name: "create_directory",
  description:
    "Create a directory in the user's Nextcloud. No-op if the directory already exists. Parent directories are NOT auto-created.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
