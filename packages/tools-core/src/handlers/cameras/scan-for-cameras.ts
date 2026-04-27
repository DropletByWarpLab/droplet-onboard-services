import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const res = await ctx.http.cameras.post("/scan", undefined);
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "SCAN_FAILED", message: `scan failed (${res.status})` },
    };
  }
  return { ok: true, data: { status: "scan_started" } };
}

const tool: Tool = {
  name: "scan_for_cameras",
  description:
    "Kick an on-demand ONVIF + RTSP scan on the cameras VLAN. Returns immediately; call list_discovered_cameras a few seconds later to see what showed up.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
