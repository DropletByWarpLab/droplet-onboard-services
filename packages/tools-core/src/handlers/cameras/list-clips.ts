import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    camera: { type: "string", description: "Optional camera name to filter by." },
    limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 30." },
  },
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const limit = Math.max(1, Math.min(200, Number(args.limit) || 30));
  const camera = typeof args.camera === "string" ? args.camera : undefined;
  // WARP-1439: route through the orchestrator, not camera-discovery.
  // camera-discovery never implemented any event/clip routes, so the old
  // ctx.http.cameras binding 404'd on every call. The orchestrator's
  // GET /api/cameras/clips already does the has_clip filtering and builds
  // the exact per-clip shape this tool used to assemble locally (id,
  // camera, label, score, start_time, end_time, thumbnail_url, clip_url).
  const url = camera
    ? `/api/cameras/clips?limit=${limit}&camera=${encodeURIComponent(camera)}`
    : `/api/cameras/clips?limit=${limit}`;
  const res = await ctx.http.orchestrator.get(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "CLIPS_FAILED", message: `orchestrator returned ${res.status}` },
    };
  }
  const body = (await res.json()) as { clips?: Array<Record<string, unknown>> };
  const clips = Array.isArray(body?.clips) ? body.clips : [];
  return { ok: true, data: { count: clips.length, clips } };
}

const tool: Tool = {
  name: "list_clips",
  description:
    "List recent camera clips (Frigate events with `has_clip=true`). Each result includes the camera, label, score, time range, and a dashboard URL the user can open.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
