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
  const url = camera
    ? `/cameras/${encodeURIComponent(camera)}/events?limit=${limit}`
    : `/events/recent?limit=${limit}`;
  const res = await ctx.http.cameras.get(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "CLIPS_FAILED", message: `cameras returned ${res.status}` },
    };
  }
  const events = (await res.json()) as Array<Record<string, unknown>>;
  const clips = events
    .filter((e) => e.has_clip === true)
    .map((e) => ({
      id: e.id,
      camera: e.camera,
      label: e.label,
      score: e.score,
      start_time: e.start_time,
      end_time: e.end_time,
      thumbnail_url: `/api/cameras/events/${e.id}/thumbnail`,
      clip_url: `/api/cameras/clips/event/${e.id}`,
    }));
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
