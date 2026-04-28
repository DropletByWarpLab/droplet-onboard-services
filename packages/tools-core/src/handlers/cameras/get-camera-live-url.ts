import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    camera: { type: "string" },
  },
  required: ["camera"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
  const name = typeof args.camera === "string" ? args.camera : "";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "invalid_camera_name" },
    };
  }
  return {
    ok: true,
    data: {
      live_url: `/cameras/${encodeURIComponent(name)}`,
      snapshot_url: `/api/cameras/${encodeURIComponent(name)}/snapshot`,
    },
  };
}

const tool: Tool = {
  name: "get_camera_live_url",
  description:
    "Return the dashboard URL for a live camera view. The user opens this in their browser and playback uses their existing session.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
