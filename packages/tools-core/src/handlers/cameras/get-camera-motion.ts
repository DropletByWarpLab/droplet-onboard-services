/**
 * WARP-3927 — `get_camera_motion` LLM tool.
 *
 * "Was there any motion at the loading dock overnight?" Motion in the
 * RETAINED RECORDINGS for a period (the orchestrator's
 * `GET /api/cameras/motion`, WARP-3510), as spans with local times. Motion is
 * recording evidence, not a detection: it shows when something moved, not
 * what.
 *
 * THE RULE THIS TOOL EXISTS TO KEEP: a stretch with no footage is not a quiet
 * stretch. The route's `coverage` object always comes back verbatim, with a
 * plain `coverageNote` sentence and an `incomplete` flag, so the model cannot
 * say "nothing happened" about time nobody recorded.
 *
 * Tier-1 read. The route is MCP-admitted and scopes to the acting person's
 * cameras (X-Nextcloud-User) like every other camera read.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import {
  describeCoverage,
  invalidArgs,
  parseBusinessHours,
  parseCameraArg,
  routeFailure,
  validMedia,
} from "./_activity.js";
import { AFTER_PROP, BEFORE_PROP, formatIsoInZone, humanDuration, resolveWindow, resolveWorkspaceTimezone } from "./_time.js";

/** The route's own ceiling (one day plus a 25-hour DST day). */
const MAX_WINDOW_SECONDS = 26 * 3600;
/** Spans returned to the model; the route holds the rest behind a cursor. */
const MAX_SPANS = 40;
const MAX_MEDIA = 3;

const inputSchema = {
  type: "object",
  properties: {
    camera: { type: "string", description: "Camera name; omit for all." },
    after: AFTER_PROP,
    before: BEFORE_PROP,
    business_hours: { type: "string", enum: ["inside", "outside"] },
  },
  required: ["after"],
  additionalProperties: false,
} as const;

interface RouteSpan {
  camera?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  motion?: unknown;
  outsideBusinessHours?: unknown;
  playbackUrl?: unknown;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const cam = parseCameraArg(args.camera);
  if (!cam.ok) return invalidArgs(cam.message);
  const hours = parseBusinessHours(args.business_hours);
  if (!hours.ok) return invalidArgs(hours.message);
  const timezone = await resolveWorkspaceTimezone(ctx);
  const win = resolveWindow(args, timezone, Math.floor(Date.now() / 1000), MAX_WINDOW_SECONDS, "26 hours");
  if (!win.ok) return invalidArgs(win.message);
  const { after, before } = win.window;

  const res = await ctx.http.orchestrator.get("/api/cameras/motion", {
    headers: { Accept: "application/json" },
    params: {
      after,
      before,
      limit: MAX_SPANS,
      ...(cam.camera ? { cameras: cam.camera } : {}),
      ...(hours.value ? { businessHours: hours.value } : {}),
    },
  });
  if (!res.ok) return routeFailure("MOTION_FAILED", "the camera motion lookup", res.status);
  const body = (await res.json()) as Record<string, unknown> | null;
  const raw = Array.isArray(body?.activity) ? (body.activity as RouteSpan[]) : [];

  const spans = raw.flatMap((s) => {
    if (s === null || typeof s !== "object" || typeof s.camera !== "string" || typeof s.startTime !== "number" || typeof s.endTime !== "number") return [];
    return [
      {
        camera: s.camera,
        start: formatIsoInZone(s.startTime, timezone),
        end: formatIsoInZone(s.endTime, timezone),
        minutes: Math.max(1, Math.round((s.endTime - s.startTime) / 60)),
        motion: typeof s.motion === "number" ? s.motion : 0,
        ...(typeof s.outsideBusinessHours === "boolean" ? { outsideBusinessHours: s.outsideBusinessHours } : {}),
        _startTime: s.startTime,
        _endTime: s.endTime,
        _playbackUrl: typeof s.playbackUrl === "string" ? s.playbackUrl : null,
      },
    ];
  });

  const coverage = describeCoverage(body?.coverage);
  const moreSpans = body?.nextCursor !== null && body?.nextCursor !== undefined;
  const reasons = [...coverage.reasons];
  if (moreSpans) reasons.push(`only the ${MAX_SPANS} most recent motion spans are shown`);

  // The most active spans play inline; the descriptor is validated with the
  // dashboard's own parser, so an unsafe URL never reaches a card.
  const media = validMedia(
    [...spans]
      .sort((a, b) => b.motion - a.motion)
      .filter((s) => s._playbackUrl !== null)
      .slice(0, MAX_MEDIA)
      .map((s) => ({
        kind: "camera_clip",
        camera: s.camera,
        playbackUrl: s._playbackUrl,
        startTime: s._startTime,
        endTime: s._endTime,
        label: `${s.camera} motion, ${s.minutes} min`,
      })),
    MAX_MEDIA,
  );

  return {
    ok: true,
    data: {
      type: "get_camera_motion",
      timezone,
      period: {
        start: formatIsoInZone(after, timezone),
        end: formatIsoInZone(before, timezone),
        length: humanDuration(before - after),
        ...(win.window.clampedToNow ? { endClampedToNow: true } : {}),
      },
      spanCount: spans.length,
      spans: spans.map(({ _startTime, _endTime, _playbackUrl, ...rest }) => rest),
      moreSpans,
      motionNote: "motion is a relative count from the recordings; compare spans with each other, it is not a percentage",
      coverage: body?.coverage ?? null,
      coverageNote: coverage.note,
      incomplete: reasons.length > 0,
      ...(media.length > 0 ? { media } : {}),
    },
  };
}

const tool: Tool = {
  name: "get_camera_motion",
  description:
    "Motion spans in recorded footage over a period (max 26h, default end now) with local times, plus coverage and coverageNote. No motion in a stretch with no footage is NOT an all-clear: relay coverageNote. For the whole picture use summarize_camera_activity.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
