import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  // Route through the orchestrator's /api/cameras instead of the
  // camera-discovery service directly. Three reasons:
  //   1. camera-discovery runs network_mode: host and exposes a
  //      different URL shape (/cameras/known returns a raw array, no
  //      `cameras:` key the redaction below expects).
  //   2. The orchestrator's route aggregates camera-discovery state +
  //      Frigate recording status into the canonical {cameras:[…]}
  //      response the dashboard also consumes, so voice + chat + UI
  //      all see the same shape.
  //   3. mcp-server's createHttpClient auto-injects the service-principal
  //      JWT for the orchestrator target (closes the auth gap that
  //      previously surfaced as HTTP 401 here for service callers).
  const res = await ctx.http.orchestrator.get("/api/cameras", { headers: { Accept: "application/json" } });
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "CAMERAS_UNAVAILABLE", message: `cameras service returned ${res.status}` },
    };
  }
  const data = (await res.json()) as Record<string, unknown> | { cameras?: unknown[] };
  // Redact internal IPs/MACs — the LLM has no legitimate need to see them.
  if (
    data &&
    typeof data === "object" &&
    "cameras" in data &&
    Array.isArray((data as { cameras: unknown[] }).cameras)
  ) {
    for (const cam of (data as { cameras: Array<Record<string, unknown>> }).cameras) {
      delete cam.ipAddress;
      delete cam.macAddress;
    }
  }
  return { ok: true, data };
}

const tool: Tool = {
  name: "list_cameras",
  description:
    "List all security cameras connected to the Droplet NVR (Frigate). Returns camera names, status (recording/detecting/offline), manufacturer, and (redacted) connection info.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
