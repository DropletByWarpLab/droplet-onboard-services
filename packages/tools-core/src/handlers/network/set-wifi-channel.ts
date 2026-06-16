import type { Tool, ToolContext, ToolResult } from "../../types.js";
import {
  confirmationRequired,
  isConfirmationResponse,
  passThroughConfirmation,
} from "../../confirmation.js";

const inputSchema = {
  type: "object",
  properties: {
    channel: {
      type: "string",
      description: "Channel number (e.g. '6', '36', '149') or 'auto'.",
    },
    confirmed: {
      type: "boolean",
      description:
        "Set true ONLY after the user has explicitly approved changing the Wi-Fi channel in this conversation. Omit (or set false) on the first call — the tool will reply confirmation_required with a prompt to relay to the user.",
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

  // Confirmation gate — same rationale as set-wifi-ssid.ts: the orchestrator
  // route is Tier 1, so the confirmation this tool advertises is enforced
  // here, mirroring memory/extract.ts.
  if (args.confirmed !== true) {
    return confirmationRequired(
      `Changing the Wi-Fi channel to "${channel}" briefly drops every wireless device while the radio restarts. ` +
        "Ask the user to approve, then re-issue this call with confirmed: true. " +
        "Do NOT set confirmed: true without an explicit yes from the user.",
      { type: "wifi_channel_change", channel },
    );
  }

  const res = await ctx.http.orchestrator.post("/api/network/wifi/channel", { channel });
  if (isConfirmationResponse(res)) return passThroughConfirmation(res);
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "SET_WIFI_CHANNEL_FAILED", message: `orchestrator returned ${res.status}` },
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
