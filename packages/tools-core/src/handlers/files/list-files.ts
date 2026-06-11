import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { validateNcPath } from "./_paths.js";

const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Directory path to list. Defaults to '/'." },
  },
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  // TOOLS-03: list_files passes its `path` as the ENTIRE WebDAV URL path
  // (`joinUrl` does `new URL(path, base)`), so a `..`-laden or absolute
  // path could resolve outside the intended prefix. Enforce the same
  // auth + traversal gate the write file-tools use. Default to "/" before
  // validating so a no-arg listing still works.
  if (!ctx.userId || !ctx.ncToken) {
    return {
      ok: false,
      status: "error",
      error: { code: "AUTH_REQUIRED", message: "auth_required" },
    };
  }
  const requested =
    typeof args.path === "string" && args.path.length > 0 ? args.path : "/";
  const v = validateNcPath(requested);
  if (!v.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_PATH", message: v.error },
    };
  }
  const path = v.path;
  const headers: Record<string, string> = {
    "X-Nextcloud-Token": ctx.ncToken,
    "X-Nextcloud-User": ctx.userId,
  };
  // WARP-861: the files API lists via `GET /?path=<dir>` — the path rides
  // in the query, not the URL path (which only matched "/" by accident).
  const res = await ctx.http.nextcloud.get(
    `/?path=${encodeURIComponent(path)}`,
    { headers },
  );
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
    "List files and directories at a path in the user's Droplet file storage. Defaults to '/'. NOTE: files attached in chat live in brain memory, not here — use search_content to find their contents.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
