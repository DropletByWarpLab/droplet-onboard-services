import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    camera_name: { type: "string", description: "Optional camera name to filter by." },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: "Max events to return (default 20).",
    },
  },
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
  const camera = typeof args.camera_name === "string" ? args.camera_name : undefined;
  // WARP-1439: route through the orchestrator, not camera-discovery.
  // camera-discovery never implemented any event routes, so the old
  // ctx.http.cameras binding 404'd on every call. The orchestrator fronts
  // Frigate (services/frigate.client.ts) and both routes below return the
  // same `{ events: DetectionEvent[] }` shape; the mcp-server's
  // createHttpClient auto-injects the service-principal Bearer for this
  // target (same pattern as list-cameras.ts).
  const url = camera
    ? `/api/cameras/${encodeURIComponent(camera)}/events?limit=${limit}`
    : `/api/cameras/events/recent?limit=${limit}`;
  const res = await ctx.http.orchestrator.get(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "EVENTS_FAILED", message: `orchestrator returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "list_camera_events",
  description:
    "Fetch recent Frigate detection events (motion/person/car/etc). Default 20 events. Use camera_name to filter to one camera.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
