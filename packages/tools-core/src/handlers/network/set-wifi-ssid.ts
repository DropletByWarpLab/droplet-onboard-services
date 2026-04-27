import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { isConfirmationResponse, passThroughConfirmation } from "../../confirmation.js";

const inputSchema = {
  type: "object",
  properties: {
    ssid: { type: "string", description: "The new SSID name (1-32 characters)." },
  },
  required: ["ssid"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const ssid = typeof args.ssid === "string" ? args.ssid : null;
  if (!ssid || ssid.length < 1 || ssid.length > 32) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "ssid must be a string of 1-32 characters" },
    };
  }
  const res = await ctx.http.routing.post("/wifi/ssid", { ssid });
  if (isConfirmationResponse(res)) return passThroughConfirmation(res);
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "SET_WIFI_SSID_FAILED", message: `routing returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "set_wifi_ssid",
  description: "Change the Wi-Fi SSID. Destructive: requires user confirmation.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
