import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { isConfirmationResponse, passThroughConfirmation } from "../../confirmation.js";

const inputSchema = {
  type: "object",
  properties: {
    channel: {
      type: "string",
      description: "Channel number (e.g. '6', '36', '149') or 'auto'.",
    },
  },
  required: ["channel"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const channel = typeof args.channel === "string" ? args.channel : null;
  if (!channel) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "channel is required" },
    };
  }
  const res = await ctx.http.routing.post("/wifi/channel", { channel });
  if (isConfirmationResponse(res)) return passThroughConfirmation(res);
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "SET_WIFI_CHANNEL_FAILED", message: `routing returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "set_wifi_channel",
  description: "Change the Wi-Fi channel ('auto' or a numeric channel). Destructive: requires user confirmation.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
