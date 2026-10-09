import { eventsMedia } from "@droplet/shared-types";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { EVENT_FILTER_PROPERTIES, parseEventFilters } from "./_event-filters.js";
import { formatIsoInZone, withLocalTimes } from "./_time.js";

const CAMERA_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const inputSchema = {
  type: "object",
  properties: {
    camera_name: { type: "string", description: "Optional camera name to filter by." },
    ...EVENT_FILTER_PROPERTIES,
    labels: { type: "string", description: "Comma-separated, e.g. person,car." },
    min_score: { type: "number", minimum: 0, maximum: 1 },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: "Max events to return (default 20).",
    },
  },
  additionalProperties: false,
} as const;

function invalid(message: string): ToolResult {
  return { ok: false, status: "error", error: { code: "INVALID_ARGS", message } };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
  let camera: string | undefined;
  if (args.camera_name !== undefined && args.camera_name !== null && args.camera_name !== "") {
    if (typeof args.camera_name !== "string" || !CAMERA_NAME_RE.test(args.camera_name)) {
      return invalid("camera_name must be a valid camera name (letters, digits, underscores, hyphens)");
    }
    camera = args.camera_name;
  }
  const parsed = await parseEventFilters(args, ctx, true);
  if (!parsed.ok) return invalid(parsed.message);
  const { filters } = parsed;

  // WARP-1439: route through the orchestrator, not camera-discovery.
  // camera-discovery never implemented any event routes, so the old
  // ctx.http.cameras binding 404'd on every call. The orchestrator fronts
  // Frigate (services/frigate.client.ts) and the mcp-server's
  // createHttpClient auto-injects the service-principal Bearer for this
  // target (same pattern as list-cameras.ts).
  const recentUrl = camera
    ? `/api/cameras/${encodeURIComponent(camera)}/events?limit=${limit}`
    : `/api/cameras/events/recent?limit=${limit}`;
  // WARP-3747: with a time / label / score filter the question is "events in
  // THIS window", which only the filtered route can answer (newest first,
  // `after`/`before` in epoch seconds). Without one, keep the cached
  // recent-events routes: same newest-first answer, no scan.
  const res = filters.active
    ? await ctx.http.orchestrator.get("/api/cameras/events", {
        headers: { Accept: "application/json" },
        params: { ...filters.params, limit, ...(camera ? { cameras: camera } : {}) },
      })
    : await ctx.http.orchestrator.get(recentUrl, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "EVENTS_FAILED", message: `orchestrator returned ${res.status}` },
    };
  }
  const data = await res.json();
  const body = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const rawEvents = Array.isArray(body.events) ? (body.events as unknown[]) : [];
  // Local ISO times beside the epoch fields (epoch kept: nothing downstream may break).
  const events = rawEvents.map((e) =>
    e && typeof e === "object" ? withLocalTimes(e as Record<string, unknown>, filters.timezone) : e,
  );
  // WARP-3691: show the newest events with a clip or still inline in chat.
  const media = eventsMedia(events);
  return {
    ok: true,
    data: {
      ...body,
      events,
      timezone: filters.timezone,
      ...(filters.after !== undefined ? { afterIso: formatIsoInZone(filters.after, filters.timezone) } : {}),
      ...(filters.before !== undefined ? { beforeIso: formatIsoInZone(filters.before, filters.timezone) } : {}),
      ...(body.scanLimitReached === true
        ? { note: "Scan limit reached: older matching events may exist. Narrow the time window or labels." }
        : {}),
      ...(media.length > 0 ? { media } : {}),
    },
  };
}

const tool: Tool = {
  name: "list_camera_events",
  description:
    "List camera detections (person, car, ...), newest first; filter by camera_name, after/before, labels, min_score. Times come back as startTimeIso/endTimeIso. For 'what happened' over a period use summarize_camera_activity.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
