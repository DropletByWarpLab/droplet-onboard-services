/**
 * WARP-1440 — `get_camera_health` LLM tool.
 *
 * "Are my cameras OK?" — per-camera stream fps/status plus
 * detector/GPU/uptime for the whole camera system.
 *
 * Source choice: the orchestrator's `GET /api/cameras/system`
 * (camera-system.service.ts `getCameraSystemStatus`) rather than the
 * raw `GET /api/cameras/stats` passthrough. The system route is the
 * typed wrapper over Frigate's /api/stats + /api/version that already
 * normalises the version-drifting wire shape (gpu_usages percentage
 * strings, storage key variants) and computes everything this tool
 * needs — per-camera fps, detectors, GPUs, storage, uptime, aggregate
 * CPU — in ONE round-trip; /cameras/stats is the untyped escape hatch
 * whose shape changes across Frigate versions. When Frigate is
 * unreachable the route still answers 200 with an empty status
 * (EMPTY_SYSTEM_STATUS), so a non-OK here means the orchestrator
 * itself failed.
 *
 * Per-camera `status` is derived the same way the service derives its
 * `camerasLive` count: cameraFps > 0 → "streaming" (actively receiving
 * frames), otherwise "no_signal".
 *
 * Goes through `ctx.http.orchestrator` (never `ctx.http.cameras`) for
 * the same reasons as `list-cameras.ts`: canonical aggregated shape +
 * auto-injected service-principal JWT. Tier-1 read — no writes, no
 * confirmation.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

/** Same convention the orchestrator route enforces (cameras.ts CAMERA_NAME_RE). */
const CAMERA_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const inputSchema = {
  type: "object",
  properties: {
    camera: {
      type: "string",
      description:
        "Optional camera name to report on alone (as returned by list_cameras). Omit for all cameras.",
    },
  },
  additionalProperties: false,
} as const;

function invalidArgs(message: string): ToolResult {
  return {
    ok: false,
    status: "error",
    error: { code: "INVALID_ARGS", message },
  };
}

function healthUnavailable(detail: string): ToolResult {
  return {
    ok: false,
    status: "error",
    error: {
      code: "HEALTH_UNAVAILABLE",
      message: `camera system health is not available — ${detail}`,
    },
  };
}

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  let camera: string | undefined;
  if (args.camera !== undefined) {
    // The regex rejects empty and whitespace-bearing names outright, so
    // no separate trim/empty check is needed.
    if (typeof args.camera !== "string" || !CAMERA_NAME_RE.test(args.camera)) {
      return invalidArgs(
        "camera must be a valid camera name (letters, digits, underscores, hyphens)",
      );
    }
    camera = args.camera;
  }

  let status: Record<string, unknown>;
  try {
    const res = await ctx.http.orchestrator.get("/api/cameras/system", {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return healthUnavailable(`orchestrator returned ${res.status}`);
    }
    const payload = (await res.json()) as { status?: unknown };
    if (payload.status === null || typeof payload.status !== "object") {
      return healthUnavailable("orchestrator returned an unexpected shape");
    }
    status = payload.status as Record<string, unknown>;
  } catch {
    return healthUnavailable("orchestrator not reachable");
  }

  const fpsList = Array.isArray(status.cameraFps)
    ? (status.cameraFps as Array<Record<string, unknown>>)
    : [];

  let cameras = fpsList.map((c) => ({
    name: String(c.name ?? ""),
    // Same liveness rule camera-system.service.ts uses for camerasLive:
    // non-zero camera_fps in the last poll == actively receiving frames.
    status: Number(c.cameraFps ?? 0) > 0 ? "streaming" : "no_signal",
    cameraFps: Number(c.cameraFps ?? 0),
    detectionFps: Number(c.detectionFps ?? 0),
    skippedFps: Number(c.skippedFps ?? 0),
  }));

  if (camera !== undefined) {
    cameras = cameras.filter((c) => c.name === camera);
    if (cameras.length === 0) {
      // Derived from the response we already have — no second round-trip.
      return {
        ok: false,
        status: "error",
        error: {
          code: "CAMERA_NOT_FOUND",
          message: `no camera named "${camera}" in the NVR's current stats — use list_cameras to see valid names`,
        },
      };
    }
  }

  return {
    ok: true,
    data: {
      type: "get_camera_health",
      cameras,
      system: {
        version: status.version ?? "unknown",
        uptimeSec: Number(status.uptimeSec ?? 0),
        cameraCount: Number(status.cameraCount ?? 0),
        camerasLive: Number(status.camerasLive ?? 0),
        cpuPct: Number(status.cpuPct ?? 0),
        detectors: Array.isArray(status.detectors) ? status.detectors : [],
        gpus: Array.isArray(status.gpus) ? status.gpus : [],
        storage: Array.isArray(status.storage) ? status.storage : [],
      },
    },
  };
}

const tool: Tool = {
  name: "get_camera_health",
  description:
    'Health of the security-camera system — per-camera stream status and fps (streaming vs no signal) plus NVR detector inference speed, GPU load, storage, and uptime. Use to answer "are my cameras OK?" or to diagnose a camera that stopped recording. Optionally pass `camera` to report on a single camera.',
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
