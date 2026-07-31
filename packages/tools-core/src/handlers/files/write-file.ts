import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { MAX_WRITE_BYTES, validateNcPath } from "./_paths.js";

const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Full target path including filename." },
    content: {
      type: "string",
      description: "UTF-8 text content (use this OR content_base64).",
    },
    content_base64: {
      type: "string",
      description: "Base64-encoded binary content (use this OR content).",
    },
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
  // WARP-1373: a trailing separator is normalized away for the tools that
  // address directories, but this one needs a filename. Without this,
  // write_file("/Notes/") would silently create a file named "Notes" at
  // root instead of erroring the way it used to.
  if (v.trailingSlash) {
    return err("INVALID_PATH", "path must include a filename, not a trailing '/'");
  }

  let buffer: Buffer;
  if (typeof args.content === "string") {
    buffer = Buffer.from(args.content, "utf8");
  } else if (typeof args.content_base64 === "string") {
    const cleaned = args.content_base64.replace(/\s+/g, "");
    buffer = Buffer.from(cleaned, "base64");
    if (buffer.toString("base64").replace(/=+$/, "") !== cleaned.replace(/=+$/, "")) {
      return err("INVALID_BASE64", "invalid base64 content");
    }
  } else {
    return err("INVALID_ARGS", "either content or content_base64 is required");
  }
  if (buffer.byteLength > MAX_WRITE_BYTES) {
    return err("TOO_LARGE", `content too large (max ${MAX_WRITE_BYTES} bytes)`);
  }

  const dir = path.posix.dirname(v.path) || "/";
  const filename = path.posix.basename(v.path);
  if (!filename) return err("INVALID_PATH", "path must include a filename");

  const headers: Record<string, string> = {
    "X-Nextcloud-Token": ctx.ncToken,
    "X-Nextcloud-User": ctx.userId,
  };
  // Encode the binary body as base64 so the abstract HttpClient can route
  // it to the underlying WebDAV PUT without binary-safety concerns.
  const res = await ctx.http.nextcloud.post(
    "/upload",
    {
      dir,
      filename,
      contentBase64: buffer.toString("base64"),
    },
    { headers },
  );
  if (!res.ok) {
    return err("WRITE_FAILED", `nextcloud returned ${res.status}`);
  }
  return { ok: true, data: { written: v.path, bytes: buffer.byteLength } };
}

const tool: Tool = {
  name: "write_file",
  description:
    "Create or overwrite a file in the user's Nextcloud. Pass `path` (full target including filename) and either `content` (UTF-8 text) or `content_base64` (binary). Max 10 MB per call.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
