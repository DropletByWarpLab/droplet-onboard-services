import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { validateNcPath } from "./_paths.js";

const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Current full path." },
    new_name: { type: "string", description: "New filename (basename only, no '/')." },
  },
  required: ["path", "new_name"],
  additionalProperties: false,
} as const;

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId || !ctx.ncToken) return err("AUTH_REQUIRED", "auth_required");
  const v = validateNcPath(args.path);
  if (!v.ok) return err("INVALID_PATH", v.error);
  if (v.path === "/") return err("INVALID_PATH", "cannot rename root");

  const newName = typeof args.new_name === "string" ? args.new_name : "";
  if (!newName) return err("INVALID_ARGS", "new_name is required");
  // Iteratively percent-decode so '%2f', '%2e%2e' etc. can't smuggle a
  // separator or traversal segment past the literal-character check.
  let decodedName = newName;
  for (let i = 0; i < 4 && decodedName.includes("%"); i++) {
    let next: string;
    try {
      next = decodeURIComponent(decodedName);
    } catch {
      return err("INVALID_ARGS", "malformed percent-encoding in new_name");
    }
    if (next === decodedName) break;
    decodedName = next;
  }
  for (const candidate of [newName, decodedName]) {
    if (
      candidate.includes("/") ||
      candidate.includes("\\") ||
      candidate.includes("\0") ||
      candidate === "." ||
      candidate === ".."
    ) {
      return err(
        "INVALID_ARGS",
        "new_name must be a plain filename — no slashes, no '.', '..', or null bytes",
      );
    }
  }

  const dir = path.posix.dirname(v.path) || "/";
  const dest = dir === "/" ? `/${newName}` : `${dir}/${newName}`;

  const headers: Record<string, string> = {
    "X-Nextcloud-Token": ctx.ncToken,
    "X-Nextcloud-User": ctx.userId,
  };
  const res = await ctx.http.nextcloud.post(
    "/move",
    { from: v.path, to: dest, overwrite: false },
    { headers },
  );
  if (!res.ok) return err("RENAME_FAILED", `nextcloud returned ${res.status}`);
  return { ok: true, data: { renamed_from: v.path, renamed_to: dest } };
}

const tool: Tool = {
  name: "rename_file",
  description:
    "Rename a file or directory in place (parent directory unchanged). Pass the current full path and the new basename (filename only, no slashes). Use move_file to change parent directory.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
