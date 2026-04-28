import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search term (substring, case-insensitive)." },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "query is required" },
    };
  }
  if (!ctx.userId || !ctx.ncToken) {
    return {
      ok: false,
      status: "error",
      error: { code: "AUTH_REQUIRED", message: "user must be authenticated for file search" },
    };
  }
  const headers: Record<string, string> = { "X-Nextcloud-Token": ctx.ncToken };
  const res = await ctx.http.nextcloud.get(
    `/search?query=${encodeURIComponent(query)}&limit=50`,
    { headers },
  );
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "SEARCH_FAILED", message: `nextcloud returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "search_files",
  description:
    "Search Nextcloud by filename (substring, case-insensitive). For semantic full-text search across document content use search_content.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
