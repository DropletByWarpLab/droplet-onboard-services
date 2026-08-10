/**
 * WARP-1850 — `get_camera_storage` LLM tool.
 *
 * "Which camera is filling the drive?" / "How long until it's full?"
 *
 * Source: the orchestrator's `GET /api/cameras/storage`
 * (camera-storage.service.ts), which merges Frigate's per-camera usage +
 * measured bitrate with the recordings-volume totals.
 *
 * Unlike `get_camera_health`, this route does NOT degrade to an empty
 * payload when Frigate is unreachable — it answers 503. That is
 * deliberate and this handler preserves it: a breakdown of zero cameras
 * reads as "nothing is using disk", which is the same false-reassurance
 * that let WARP-1849's dead retention purge look healthy for its whole
 * life. When we can't measure, we say so.
 *
 * `null` values are passed through as `null`, never coerced to 0 —
 * "not recorded yet" and "uses no space" are different answers, and the
 * model should not state the second when the truth is the first.
 *
 * Goes through `ctx.http.orchestrator` for the same reasons as
 * `list-cameras.ts`: canonical aggregated shape + auto-injected
 * service-principal JWT. Tier-1 read — no writes, no confirmation.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

function storageUnavailable(reason: string): ToolResult {
  return {
    ok: false,
    status: "error",
    error: {
      code: "STORAGE_UNAVAILABLE",
      message: `camera storage usage is unavailable (${reason}) — this is not a report that cameras are using no space`,
    },
  };
}

async function handler(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
  let payload: Record<string, unknown>;
  try {
    const res = await ctx.http.orchestrator.get("/api/cameras/storage", {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return storageUnavailable(`orchestrator returned ${res.status}`);
    }
    const body = (await res.json()) as unknown;
    if (body === null || typeof body !== "object") {
      return storageUnavailable("orchestrator returned an unexpected shape");
    }
    payload = body as Record<string, unknown>;
  } catch {
    return storageUnavailable("orchestrator not reachable");
  }

  const cameras = Array.isArray(payload.cameras)
    ? (payload.cameras as Array<Record<string, unknown>>).map((c) => ({
        camera: String(c.camera ?? ""),
        // Preserve null — see the module docstring.
        usedBytes: c.usedBytes === null ? null : Number(c.usedBytes ?? 0),
        bytesPerHour: c.bytesPerHour === null ? null : Number(c.bytesPerHour ?? 0),
        sharePercent: c.sharePercent === null ? null : Number(c.sharePercent ?? 0),
        daysAtCurrentRate:
          c.daysAtCurrentRate === null ? null : Number(c.daysAtCurrentRate ?? 0),
      }))
    : [];

  return {
    ok: true,
    data: {
      type: "get_camera_storage",
      volume: payload.volume ?? null,
      cameras,
      nearFull: payload.nearFull === true,
      totalBytesPerHour:
        payload.totalBytesPerHour === null
          ? null
          : Number(payload.totalBytesPerHour ?? 0),
    },
  };
}

const tool: Tool = {
  name: "get_camera_storage",
  description:
    'How the security cameras are using recording storage — per-camera space used, measured recording rate, each camera\'s share of the drive, and whether the drive is nearly full. Use to answer "which camera is using the most space?", "how full is the camera drive?", or "how long until I run out of recording space?". A camera that has not recorded yet reports null rather than zero.',
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
