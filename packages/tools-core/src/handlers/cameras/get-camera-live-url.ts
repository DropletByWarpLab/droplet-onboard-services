import { cameraLiveMedia } from "@droplet/shared-types";
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
      // WARP-3691: the chat renders this as a live feed card.
      media: cameraLiveMedia(name),
    },
  };
}

const tool: Tool = {
  name: "get_camera_live_url",
  description:
    "Show the user a LIVE view of a camera. The live feed appears inline in the chat (it starts when the user clicks play), so use this when the user asks to watch a camera live - and do not paste the URL in your reply.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
