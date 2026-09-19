import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { isConfirmationResponse, passThroughConfirmation } from "../../confirmation.js";

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
  // Route through the ORCHESTRATOR, not the cameras service. Minting a public
  // "anyone with the link" signed URL to private footage is a Tier-2 action:
  // the orchestrator's /api/cameras/clips/share endpoint runs it through the
  // safety-tier evaluator, which answers 202 `confirmation_required` on the
  // first (unattended) call. Without this hop the agent could sign a URL in a
  // single tool call, defeating the requiresConfirmation flag (the cameras
  // service has no share endpoint and applies no confirmation gate). Same
  // pattern as add_port_forward. The per-user Nextcloud identity rides in the
  // X-Nextcloud-User header — the orchestrator honors it for the MCP service
  // principal (req.user.username is `_service:mcp`, not the human's NC user).
  const headers: Record<string, string> = {
    "X-Nextcloud-User": ctx.userId,
  };
  const res = await ctx.http.orchestrator.post(
    "/api/cameras/clips/share",
    { nc_path: ncPath, ttl_minutes: ttlMin },
    { headers },
  );
  if (isConfirmationResponse(res)) return passThroughConfirmation(res);
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "SHARE_FAILED", message: `orchestrator returned ${res.status}` },
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
  // WARP-2472 — POST /api/cameras/clips/share evaluates `share_clip` as
  // Tier 2 and answers 202 with its own token. That route is emphatically the
  // single gate: it takes a `confirmation_token` inline but 403s the
  // `_service:mcp` principal on that path by design (cameras.ts:574-578), so
  // an agent can never redeem its own approval. The interceptor stands down.
  confirmationOwner: "route",
  handler,
};

export default tool;
