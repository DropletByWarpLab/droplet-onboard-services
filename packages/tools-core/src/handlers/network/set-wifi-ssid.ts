import type { Tool, ToolContext, ToolResult } from "../../types.js";
import {
  confirmationRequired,
  isConfirmationResponse,
  passThroughConfirmation,
} from "../../confirmation.js";

const inputSchema = {
  type: "object",
  properties: {
    ssid: { type: "string", description: "The new SSID name (1-32 characters)." },
    confirmed: {
      type: "boolean",
      description:
        "Set true ONLY after the user has explicitly approved renaming the Wi-Fi network in this conversation. Omit (or set false) on the first call — the tool will reply confirmation_required with a prompt to relay to the user.",
    },
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

  // Confirmation gate — the orchestrator's /api/network/wifi/ssid route is
  // deliberately Tier 1 (the setup wizard applies it with no confirmation,
  // docs/SETUP_WIZARD_WALKTHROUGH.md), so the AI-side confirmation this tool
  // advertises is enforced HERE, mirroring memory/extract.ts. After
  // validation, before any write.
  if (args.confirmed !== true) {
    return confirmationRequired(
      `Renaming the Wi-Fi network to "${ssid}" will disconnect every wireless device until it rejoins. ` +
        "Ask the user to approve, then re-issue this call with confirmed: true. " +
        "Do NOT set confirmed: true without an explicit yes from the user.",
      { type: "wifi_ssid_change", ssid },
    );
  }

  const res = await ctx.http.orchestrator.post("/api/network/wifi/ssid", { ssid });
  if (isConfirmationResponse(res)) return passThroughConfirmation(res);
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "SET_WIFI_SSID_FAILED", message: `orchestrator returned ${res.status}` },
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
