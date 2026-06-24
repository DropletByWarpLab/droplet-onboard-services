import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    nc_path: {
      type: "string",
      description: "Path returned by export_clip (e.g. /Clips/front/20260423-140000Z.mp4).",
    },
    ttl_minutes: { type: "integer", minimum: 1, maximum: 1440 },
  },
  required: ["nc_path"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) {
    return {
      ok: false,
      status: "error",
      error: { code: "AUTH_REQUIRED", message: "auth_required" },
    };
  }
  const ncPath = typeof args.nc_path === "string" ? args.nc_path : null;
  if (!ncPath) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "nc_path is required" },
    };
  }
  const ttlMin = Math.max(1, Math.min(1440, Number(args.ttl_minutes) || 60));
  const headers: Record<string, string> = {
    "X-Nextcloud-User": ctx.userId,
  };
  const res = await ctx.http.cameras.post(
    "/clips/share",
    { nc_path: ncPath, ttl_minutes: ttlMin },
    { headers },
  );
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "SHARE_FAILED", message: `cameras returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "share_clip",
  description:
    "Generate a short-lived signed URL for a saved clip in the user's Nextcloud. Anyone with the link can watch the clip until it expires. Default TTL 60 minutes; max 24 hours.",
  inputSchema,
  requiresWrite: true,
  // Minting a public "anyone with the link" URL to private camera footage
  // is a footgun if it fires unattended: the resulting signed URL is
  // unauthenticated for its whole TTL. Require explicit user confirmation.
  requiresConfirmation: true,
  handler,
};

export default tool;
