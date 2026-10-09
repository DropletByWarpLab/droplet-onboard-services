/**
 * WARP-3927 — `list_camera_reviews` LLM tool.
 *
 * Frigate groups detections into "review items" — the unit the Cameras page
 * and the notifications are built on — and grades each one: an `alert`
 * (a person, a car in a watched zone), a plain `detection`, or
 * `significant_motion`. This tool lists them, alerts first, so "did anything
 * need my attention?" is answerable without paging raw detections.
 * `GET /api/cameras/reviews`, MCP-admitted and scoped to the acting person's
 * cameras.
 *
 * Thumbnails go out as media only through the route that exists for them,
 * `/api/cameras/reviews/:id/thumbnail`, paired with the footage's HLS
 * playlist so the card plays the real recording.
 *
 * Tier-1 read.
 */
import { EVENT_ID_RE, recordingPlaybackUrl } from "@droplet/shared-types";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import {
  CAMERA_NAME_RE,
  invalidArgs,
  parseBusinessHours,
  parseCsvArg,
  routeFailure,
  validMedia,
} from "./_activity.js";
import { parseEventFilters } from "./_event-filters.js";
import { AFTER_PROP, BEFORE_PROP, formatIsoInZone } from "./_time.js";

const SEVERITIES = ["alert", "detection", "significant_motion"] as const;
const SEVERITY_RANK: Record<string, number> = { alert: 0, detection: 1, significant_motion: 2 };
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** Rows pulled from the route so "alerts first" is chosen over a real page, not over the newest 20. */
const FETCH_ROWS = 100;
const MAX_MEDIA = 4;

const inputSchema = {
  type: "object",
  properties: {
    cameras: { type: "string", description: "Comma-separated; omit for all." },
    severity: { type: "string", description: "Comma-separated: alert, detection, significant_motion." },
    after: AFTER_PROP,
    before: BEFORE_PROP,
    business_hours: { type: "string", enum: ["inside", "outside"] },
    limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "Default 20." },
  },
  additionalProperties: false,
} as const;

interface RouteReview {
  id?: unknown;
  camera?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  severity?: unknown;
  hasBeenReviewed?: unknown;
  objects?: unknown;
  zones?: unknown;
  outsideBusinessHours?: unknown;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const cams = parseCsvArg(args.cameras, "cameras", (c) => CAMERA_NAME_RE.test(c), 20);
  if (!cams.ok) return invalidArgs(cams.message);
  const sev = parseCsvArg(args.severity, "severity", (s) => (SEVERITIES as readonly string[]).includes(s), 3);
  if (!sev.ok) return invalidArgs(sev.message);
  const hours = parseBusinessHours(args.business_hours);
  if (!hours.ok) return invalidArgs(hours.message);
  const parsed = await parseEventFilters(args, ctx, false);
  if (!parsed.ok) return invalidArgs(parsed.message);
  const { filters } = parsed;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(Number(args.limit)) || DEFAULT_LIMIT));

  const res = await ctx.http.orchestrator.get("/api/cameras/reviews", {
    headers: { Accept: "application/json" },
    params: {
      ...filters.params,
      limit: FETCH_ROWS,
      ...(cams.values.length > 0 ? { cameras: cams.values.join(",") } : {}),
      ...(sev.values.length > 0 ? { severity: sev.values.join(",") } : {}),
      ...(hours.value ? { businessHours: hours.value } : {}),
    },
  });
  if (!res.ok) return routeFailure("REVIEWS_FAILED", "the camera review lookup", res.status);
  const body = (await res.json()) as Record<string, unknown> | null;
  const raw = Array.isArray(body?.reviews) ? (body.reviews as RouteReview[]) : [];

  // Alerts first, then detections, then significant motion; newest first within each.
  const ordered = raw
    .filter((r) => r !== null && typeof r === "object" && typeof r.id === "string" && typeof r.camera === "string" && typeof r.startTime === "number")
    .sort(
      (a, b) =>
        (SEVERITY_RANK[String(a.severity)] ?? 3) - (SEVERITY_RANK[String(b.severity)] ?? 3) ||
        (b.startTime as number) - (a.startTime as number),
    );
  const shown = ordered.slice(0, limit);
  const counts: Record<string, number> = {};
  for (const r of ordered) counts[String(r.severity)] = (counts[String(r.severity)] ?? 0) + 1;
  const moreAvailable = ordered.length > shown.length || (body?.nextCursor !== null && body?.nextCursor !== undefined) || body?.scanLimitReached === true;

  const reviews = shown.map((r) => ({
    id: r.id as string,
    camera: r.camera as string,
    severity: String(r.severity),
    start: formatIsoInZone(r.startTime as number, filters.timezone),
    end: typeof r.endTime === "number" ? formatIsoInZone(r.endTime, filters.timezone) : null,
    objects: strings(r.objects),
    zones: strings(r.zones),
    reviewed: r.hasBeenReviewed === true,
    ...(typeof r.outsideBusinessHours === "boolean" ? { outsideBusinessHours: r.outsideBusinessHours } : {}),
  }));

  const media = validMedia(
    shown
      .filter((r) => EVENT_ID_RE.test(r.id as string) && typeof r.endTime === "number" && (r.endTime as number) > (r.startTime as number))
      .slice(0, MAX_MEDIA)
      .map((r) => ({
        kind: "camera_clip",
        camera: r.camera,
        playbackUrl: recordingPlaybackUrl(r.camera as string, r.startTime as number, Math.ceil(r.endTime as number)),
        thumbnailUrl: `/api/cameras/reviews/${encodeURIComponent(r.id as string)}/thumbnail`,
        startTime: r.startTime,
        endTime: r.endTime,
        label: `${String(r.severity).replace("_", " ")}: ${strings(r.objects).join(", ") || String(r.camera)}`,
      })),
    MAX_MEDIA,
  );

  return {
    ok: true,
    data: {
      type: "list_camera_reviews",
      timezone: filters.timezone,
      count: reviews.length,
      counts,
      reviews,
      moreAvailable,
      ...(moreAvailable ? { note: "More review items exist in this period than are listed; narrow the period, cameras or severity." } : {}),
      ...(media.length > 0 ? { media } : {}),
    },
  };
}

const tool: Tool = {
  name: "list_camera_reviews",
  description:
    "Frigate review items (the Cameras page / notification units), alerts first, with severity, local times, objects, zones. Use for 'did anything need my attention?'.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
