import path from "node:path";
import { artifactMediaFromPath } from "@droplet/shared-types";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { validateNcPath } from "./_paths.js";

const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "New .html path." },
    content: { type: "string", description: "HTML/CSS/JS; self-contained, inline assets; ≤192 KiB." },
  },
  required: ["path", "content"],
  additionalProperties: false,
} as const;

function error(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId || !ctx.ncToken) return error("AUTH_REQUIRED", "auth_required");
  const v = validateNcPath(args.path);
  if (!v.ok || v.trailingSlash || !v.path.toLowerCase().endsWith(".html")) {
    return error("INVALID_PATH", "path must name a new .html file without traversal");
  }
  if (typeof args.content !== "string" || !args.content.trim()) {
    return error("INVALID_ARGS", "content must contain HTML");
  }
  const bytes = Buffer.from(args.content, "utf8");
  if (bytes.length > 192 * 1024) return error("TOO_LARGE", "artifact exceeds 192 KB");
  const result = await ctx.http.nextcloud.post(
    "/upload",
    { dir: path.posix.dirname(v.path), filename: path.posix.basename(v.path), contentBase64: bytes.toString("base64"), createOnly: true },
    { headers: { "X-Nextcloud-Token": ctx.ncToken, "X-Nextcloud-User": ctx.userId }, ...(ctx.signal ? { signal: ctx.signal } : {}) },
  );
  if (result.status === 409) return error("ALREADY_EXISTS", "choose a new filename for this revision");
  if (!result.ok) return error("WRITE_FAILED", `file creation failed (${result.status})`);
  const payload: unknown = await result.json().catch(() => null);
  const uploaded = (payload as { uploaded?: { path?: unknown }[] } | null)?.uploaded?.[0]?.path;
  const saved = validateNcPath(uploaded);
  if (!saved.ok || saved.trailingSlash || !saved.path.toLowerCase().endsWith(".html")) {
    return error("WRITE_FAILED", "File storage returned no valid saved HTML path; no preview is available.");
  }
  const savedPath = saved.path;
  return { ok: true, data: { path: savedPath, bytes: bytes.length, media: artifactMediaFromPath(savedPath, bytes.length) } };
}

const tool: Tool = {
  name: "create_artifact",
  description: "Interactive HTML app/simulation/chart/dashboard; chat preview has no network/device access. Revise to new paths.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};
export default tool;
