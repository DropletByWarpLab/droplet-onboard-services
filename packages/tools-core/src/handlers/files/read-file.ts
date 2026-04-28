import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Full path to the file to read." },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

const MAX_TEXT_CHARS = 10000;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = typeof args.path === "string" ? args.path : null;
  if (!path) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "path is required" },
    };
  }
  const headers: Record<string, string> = {};
  if (ctx.ncToken) headers["X-Nextcloud-Token"] = ctx.ncToken;
  const res = await ctx.http.nextcloud.get(`/download?path=${encodeURIComponent(path)}`, { headers });
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "READ_FAILED", message: `nextcloud returned ${res.status}` },
    };
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (
    contentType.includes("text") ||
    contentType.includes("json") ||
    contentType.includes("xml")
  ) {
    const text = await res.text();
    return { ok: true, data: { path, content: text.slice(0, MAX_TEXT_CHARS) } };
  }
  return {
    ok: true,
    data: { path, error: `Binary file (type: ${contentType}), cannot read as text` },
  };
}

const tool: Tool = {
  name: "read_file",
  description:
    "Read the text content of a file on the Droplet's Nextcloud. Returns up to 10,000 characters; binary files are rejected with an explanatory note.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
