import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { validateNcPath } from "./_paths.js";

const inputSchema = {
  type: "object",
  properties: {
    from_path: { type: "string", description: "Current full path." },
    to_path: { type: "string", description: "Destination full path." },
    overwrite: { type: "boolean", description: "Replace destination if it exists. Default false." },
  },
  required: ["from_path", "to_path"],
  additionalProperties: false,
} as const;

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId || !ctx.ncToken) return err("AUTH_REQUIRED", "auth_required");
  const f = validateNcPath(args.from_path);
  if (!f.ok) return err("INVALID_PATH", `from_path: ${f.error}`);
  const t = validateNcPath(args.to_path);
  if (!t.ok) return err("INVALID_PATH", `to_path: ${t.error}`);
  if (f.path === t.path) return err("INVALID_ARGS", "from_path and to_path are the same");
  if (f.path === "/" || t.path === "/") return err("INVALID_PATH", "refusing to move root");

  const headers: Record<string, string> = {
    "X-Nextcloud-Token": ctx.ncToken,
    "X-Nextcloud-User": ctx.userId,
  };
  const overwrite = args.overwrite === true;
  const res = await ctx.http.nextcloud.post(
    "/move",
    { from: f.path, to: t.path, overwrite },
    { headers },
  );
  if (!res.ok) return err("MOVE_FAILED", `nextcloud returned ${res.status}`);
  return { ok: true, data: { moved_from: f.path, moved_to: t.path } };
}

const tool: Tool = {
  name: "move_file",
  description:
    "Move a file or directory to a new location. Pass `from_path` and `to_path`. Fails if the destination exists; pass overwrite=true to replace it.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
