import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const res = await ctx.http.routing.get("/wifi/scan", { headers: { Accept: "application/json" } });
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "ROUTING_UNAVAILABLE", message: `routing service returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "scan_wifi_networks",
  description:
    "Scan for nearby Wi-Fi networks and return their SSID, signal strength, channel, and encryption.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
