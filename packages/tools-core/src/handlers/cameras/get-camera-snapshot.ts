import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    camera: { type: "string", description: "Name of the camera to capture a snapshot from." },
  },
  required: ["camera"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
  const camera = typeof args.camera === "string" ? args.camera : null;
  if (!camera || !/^[a-zA-Z0-9_-]{1,64}$/.test(camera)) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "invalid_camera_name" },
    };
  }
  return {
    ok: true,
    data: {
      camera,
      snapshot_url: `/api/cameras/${encodeURIComponent(camera)}/snapshot`,
      note: "Snapshot URL is accessible through the Droplet dashboard.",
    },
  };
}

const tool: Tool = {
  name: "get_camera_snapshot",
  description:
    "Return the snapshot URL for a specific camera. The URL is dashboard-internal — the user opens it in their browser using their existing session.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
