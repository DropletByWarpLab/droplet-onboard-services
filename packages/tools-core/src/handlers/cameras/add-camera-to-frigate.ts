import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { isConfirmationResponse, passThroughConfirmation } from "../../confirmation.js";

const inputSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description:
        "Frigate camera name. Alphanumeric + underscores/hyphens, 1-64 chars. Example: 'hanwha_dome'.",
    },
    rtsp_url: {
      type: "string",
      description:
        "Full RTSP URL including credentials, e.g. rtsp://admin:<password>@192.168.20.176:554/profile2/media.smp for a Hanwha Wisenet camera. Must begin with rtsp:// or rtsps://.",
    },
    manufacturer: {
      type: "string",
      description: "Optional vendor name (Hanwha, Hikvision, Axis, Dahua, Reolink, Amcrest).",
    },
    model: {
      type: "string",
      description: "Optional model string from the camera's deviceinfo (e.g. XNV-C8083R).",
    },
  },
  required: ["name", "rtsp_url"],
  additionalProperties: false,
} as const;

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RTSP_RE = /^rtsps?:\/\/.+/;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const name = typeof args.name === "string" ? args.name.trim() : null;
  const rtspUrl = typeof args.rtsp_url === "string" ? args.rtsp_url.trim() : null;

  if (!name || !NAME_RE.test(name)) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "name must match [A-Za-z0-9_-]{1,64}" },
    };
  }
  if (!rtspUrl || !RTSP_RE.test(rtspUrl)) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "rtsp_url must start with rtsp:// or rtsps://" },
    };
  }

  const body: Record<string, unknown> = { name, rtspUrl };
  if (typeof args.manufacturer === "string" && args.manufacturer.trim()) body.manufacturer = args.manufacturer.trim();
  if (typeof args.model === "string" && args.model.trim()) body.model = args.model.trim();

  const res = await ctx.http.orchestrator.post("/api/cameras", body);
  if (isConfirmationResponse(res)) return passThroughConfirmation(res);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return {
      ok: false,
      status: "error",
      error: {
        code: "ADD_CAMERA_FAILED",
        message: `orchestrator /api/cameras returned ${res.status}`,
        details: detail || undefined,
      },
    };
  }
  return { ok: true, data: await res.json() };
}

const tool: Tool = {
  name: "add_camera_to_frigate",
  description:
    "Manually add a camera to Frigate with an explicit name + RTSP URL. Use when accept_discovered_camera would write the wrong URL (e.g. Hanwha cameras whose RTSP path differs from the Hikvision default). The credential MUST be embedded in rtsp_url; the service will not synthesise one. Tier-2 destructive: requires operator confirmation in the dashboard. Removable once the camera-discovery vendor URL fix lands.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
