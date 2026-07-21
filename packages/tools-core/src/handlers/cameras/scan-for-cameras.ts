import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  // WARP-1462 — route through the ORCHESTRATOR, not camera-discovery. The old
  // ctx.http.cameras.post("/scan") hit camera-discovery (:8085) directly, whose
  // /scan is gated behind a `Bearer DEVICE_SECRET` (NET-05) that the cameras
  // client never injects → every call 403'd. The orchestrator's
  // POST /api/cameras/scan fronts the same scan (forwarding DEVICE_SECRET
  // server-side) and the mcp-server's createHttpClient auto-injects the
  // service-principal Bearer for this target. Same fix class as
  // list_camera_events / export_clip (WARP-1439).
  //
  // Wire-shape change: `data` was previously the hardcoded
  // `{ status: "scan_started" }`. It is now the orchestrator's envelope, passed
  // through as-is — either `{ status: "scan_complete", known, pending }` (the
  // scan runs synchronously upstream, so it has already finished when this
  // returns) or `{ status: "scan_unavailable", message }` when the
  // camera-discovery service isn't running (returned with HTTP 200, so it
  // surfaces as ok:true).
  const res = await ctx.http.orchestrator.post("/api/cameras/scan", undefined);
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "SCAN_FAILED", message: `orchestrator returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "scan_for_cameras",
  description:
    "Kick an on-demand ONVIF + RTSP scan on the cameras VLAN. Returns the scan result; call list_discovered_cameras to see what showed up.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
