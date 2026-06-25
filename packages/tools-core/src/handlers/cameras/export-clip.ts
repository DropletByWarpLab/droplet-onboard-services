import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    camera: { type: "string" },
    starts_at: { type: "string", description: "ISO-8601 start time." },
    ends_at: { type: "string", description: "ISO-8601 end time (must be after starts_at)." },
  },
  required: ["camera", "starts_at", "ends_at"],
  additionalProperties: false,
} as const;

function parseIso(input: unknown): Date | null {
  if (typeof input !== "string" || input.length === 0) return null;
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId || !ctx.ncToken) {
    return {
      ok: false,
      status: "error",
      error: { code: "AUTH_REQUIRED", message: "auth_required" },
    };
  }
  const camera = typeof args.camera === "string" ? args.camera : null;
  const startsAt = parseIso(args.starts_at);
  const endsAt = parseIso(args.ends_at);
  if (!camera || !startsAt || !endsAt) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "invalid_iso8601_or_missing_camera" },
    };
  }
  // Enforce the documented range contract before forwarding to the cameras
  // service: ends_at must be strictly after starts_at, and the export window
  // may not exceed 30 minutes (see this tool's description).
  const durationMs = endsAt.getTime() - startsAt.getTime();
  if (durationMs <= 0) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "ends_at_must_be_after_starts_at" },
    };
  }
  const MAX_EXPORT_MS = 30 * 60 * 1000;
  if (durationMs > MAX_EXPORT_MS) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "export_window_exceeds_30_minutes" },
    };
  }
  const headers: Record<string, string> = {
    "X-Nextcloud-Token": ctx.ncToken,
    "X-Nextcloud-User": ctx.userId,
  };
  const res = await ctx.http.cameras.post(
    "/clips/export",
    {
      camera,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
    },
    { headers },
  );
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "EXPORT_FAILED", message: `cameras returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "export_clip",
  description:
    "Render a custom-range clip from a camera's recordings and save it to the user's Nextcloud at /Clips/<camera>/<timestamp>.mp4. Times are ISO-8601. Max 30 minutes per export.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
