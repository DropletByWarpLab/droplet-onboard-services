/**
 * WARP-3927 — `get_camera_recording` LLM tool.
 *
 * "Show me the front door at 6:40 last night." Plays recorded footage for one
 * camera: a 2-minute window around an instant (`at`), or a range
 * (`starts_at` .. `ends_at`, at most 30 minutes — longer is clamped and the
 * result says so).
 *
 * It checks the camera's recording segments FIRST
 * (`GET /api/cameras/:name/recordings`), so a moment with no footage comes
 * back as "no footage at that time" with the reason to give, not as a card
 * that fails to load. With footage it returns:
 *   - a `camera_clip` (MP4 + HLS) for the window, and
 *   - for `at`, a `camera_snapshot` still FROM THE RECORDING at that instant
 *     (`/api/cameras/:name/recordings/snapshot?at=`), which the assistant can
 *     also look at on a vision model. A past instant is never answered with
 *     the live frame.
 *
 * Tier-1 read.
 */
import { recordingClipUrl, recordingPlaybackUrl, recordingSnapshotUrl } from "@droplet/shared-types";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { CAMERA_NAME_RE, invalidArgs, routeFailure, validMedia } from "./_activity.js";
import { formatIsoInZone, humanDuration, parseTimeInput, resolveWorkspaceTimezone } from "./_time.js";

const MAX_RANGE_SECONDS = 30 * 60;
/** Half-width of the window around a single instant: 2 minutes in all. */
const AROUND_SECONDS = 60;
/** Missing footage shorter than this is segment rounding, not a gap. */
const GAP_TOLERANCE_SECONDS = 15;
/** Frigate cuts ~10 s segments; an instant this close to a segment edge still has a frame. */
const EDGE_TOLERANCE_SECONDS = 3;
/** The recordings route refuses a start in the future (plus its own skew). */
const FUTURE_SKEW_SECONDS = 120;

const inputSchema = {
  type: "object",
  properties: {
    camera: { type: "string", description: "Camera name." },
    at: { type: "string", description: "One moment: ISO 8601 or YYYY-MM-DD HH:mm (workspace time zone)." },
    starts_at: { type: "string", description: "Range start (needs ends_at); max 30 min." },
    ends_at: { type: "string", description: "Range end." },
  },
  required: ["camera"],
  additionalProperties: false,
} as const;

interface Segment {
  startTime: number;
  endTime: number;
}

/** Seconds of [after, before] the segments cover, and whether one holds `at`. */
function footageIn(segments: Segment[], after: number, before: number, at?: number): { seconds: number; coversAt: boolean } {
  const sorted = [...segments].sort((a, b) => a.startTime - b.startTime);
  let seconds = 0;
  let coveredUntil = after;
  let coversAt = false;
  for (const s of sorted) {
    const start = Math.max(after, s.startTime);
    const end = Math.min(before, s.endTime);
    if (end > start) {
      seconds += end - Math.max(start, coveredUntil);
      coveredUntil = Math.max(coveredUntil, end);
    }
    if (at !== undefined && at >= s.startTime - EDGE_TOLERANCE_SECONDS && at <= s.endTime + EDGE_TOLERANCE_SECONDS) {
      coversAt = true;
    }
  }
  return { seconds: Math.max(0, seconds), coversAt };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const camera = args.camera;
  if (typeof camera !== "string" || !CAMERA_NAME_RE.test(camera)) {
    return invalidArgs("camera must be a valid camera name (letters, digits, underscores, hyphens)");
  }
  const has = (v: unknown) => v !== undefined && v !== null && v !== "";
  const hasAt = has(args.at);
  const hasRange = has(args.starts_at) || has(args.ends_at);
  if (hasAt === hasRange) {
    return invalidArgs("give either `at` (one moment) or both `starts_at` and `ends_at` (a range), not both and not neither");
  }

  const timezone = await resolveWorkspaceTimezone(ctx);
  const now = Math.floor(Date.now() / 1000);
  let after: number;
  let before: number;
  let at: number | undefined;
  const notes: string[] = [];

  if (hasAt) {
    const t = parseTimeInput(args.at, timezone, "at");
    if (!t.ok) return invalidArgs(t.message);
    if (t.epoch > now + FUTURE_SKEW_SECONDS) return invalidArgs("at is in the future; there is no recording of it yet");
    at = t.epoch;
    after = at - AROUND_SECONDS;
    before = Math.max(Math.min(at + AROUND_SECONDS, now), at + 1);
  } else {
    if (!has(args.starts_at) || !has(args.ends_at)) return invalidArgs("a range needs both starts_at and ends_at");
    const a = parseTimeInput(args.starts_at, timezone, "starts_at");
    if (!a.ok) return invalidArgs(a.message);
    const b = parseTimeInput(args.ends_at, timezone, "ends_at");
    if (!b.ok) return invalidArgs(b.message);
    if (a.epoch > now + FUTURE_SKEW_SECONDS) return invalidArgs("starts_at is in the future; there is no recording of it yet");
    if (b.epoch <= a.epoch) return invalidArgs("ends_at must be later than starts_at");
    after = a.epoch;
    before = Math.min(b.epoch, now);
    if (b.epoch > now) notes.push("The end of the range is in the future, so it was cut back to now.");
    if (before <= after) return invalidArgs("starts_at is in the future; there is no recording of it yet");
    if (before - after > MAX_RANGE_SECONDS) {
      before = after + MAX_RANGE_SECONDS;
      notes.push(
        `Ranges are limited to 30 minutes, so this shows ${formatIsoInZone(after, timezone)} to ${formatIsoInZone(before, timezone)}; ask again for the rest.`,
      );
    }
  }

  const res = await ctx.http.orchestrator.get(`/api/cameras/${encodeURIComponent(camera)}/recordings`, {
    headers: { Accept: "application/json" },
    params: { after, before },
  });
  if (res.status === 404) {
    return { ok: false, status: "error", error: { code: "CAMERA_NOT_FOUND", message: `No camera named ${camera}.` } };
  }
  if (!res.ok) return routeFailure("RECORDINGS_FAILED", "the recording lookup", res.status);
  const body = (await res.json()) as { segments?: unknown } | null;
  const segments: Segment[] = (Array.isArray(body?.segments) ? (body.segments as Array<Record<string, unknown>>) : []).flatMap((s) =>
    s !== null && typeof s === "object" && typeof s.startTime === "number" && typeof s.endTime === "number" && s.endTime > s.startTime
      ? [{ startTime: s.startTime, endTime: s.endTime }]
      : [],
  );

  const period = { start: formatIsoInZone(after, timezone), end: formatIsoInZone(before, timezone) };
  const footage = footageIn(segments, after, before, at);

  if (footage.seconds <= 0) {
    return {
      ok: true,
      data: {
        type: "get_camera_recording",
        camera,
        timezone,
        footageAvailable: false,
        period,
        ...(at !== undefined ? { at: formatIsoInZone(at, timezone) } : {}),
        coverageNote: `No footage was recorded for ${camera} between ${period.start} and ${period.end}. The camera may have been offline, or it only saves recordings around motion or detections; say so rather than describing what happened.`,
        ...(notes.length > 0 ? { notes } : {}),
      },
    };
  }

  const windowSeconds = before - after;
  const missing = Math.max(0, windowSeconds - footage.seconds);
  const label = `${camera} ${period.start.slice(0, 16).replace("T", " ")}`;
  const media: unknown[] = [
    {
      kind: "camera_clip",
      camera,
      ...(windowSeconds <= MAX_RANGE_SECONDS ? { clipUrl: recordingClipUrl(camera, after, Math.ceil(before)) } : {}),
      playbackUrl: recordingPlaybackUrl(camera, after, Math.ceil(before)),
      startTime: after,
      endTime: before,
      label,
    },
  ];
  let snapshotNote: string | undefined;
  if (at !== undefined) {
    if (footage.coversAt) {
      media.push({
        kind: "camera_snapshot",
        camera,
        snapshotUrl: recordingSnapshotUrl(camera, at),
        label: `${camera} ${formatIsoInZone(at, timezone).slice(0, 19).replace("T", " ")}`,
      });
    } else {
      snapshotNote = `No recording covers exactly ${formatIsoInZone(at, timezone)}, so there is no still of that second; the clip shows the nearest footage.`;
    }
  }

  return {
    ok: true,
    data: {
      type: "get_camera_recording",
      camera,
      timezone,
      footageAvailable: true,
      period,
      ...(at !== undefined ? { at: formatIsoInZone(at, timezone), snapshotAvailable: footage.coversAt } : {}),
      footage: humanDuration(footage.seconds),
      coverageNote:
        missing > GAP_TOLERANCE_SECONDS
          ? `Footage covers ${humanDuration(footage.seconds)} of the ${humanDuration(windowSeconds)} shown; ${Math.round(missing / 60)} minutes have no recording.`
          : `Footage covers the whole ${humanDuration(windowSeconds)} shown.`,
      ...(snapshotNote ? { snapshotNote } : {}),
      ...(notes.length > 0 ? { notes } : {}),
      media: validMedia(media, 2),
    },
  };
}

const tool: Tool = {
  name: "get_camera_recording",
  description:
    "Show recorded footage from one camera: at = one moment (2-minute clip + a still from the recording), or starts_at+ends_at = a range. Says so when there is no footage.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
