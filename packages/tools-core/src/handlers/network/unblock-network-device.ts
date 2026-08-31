import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { isConfirmationResponse, passThroughConfirmation } from "../../confirmation.js";

const inputSchema = {
  type: "object",
  properties: {
    mac: {
      type: "string",
      description: "MAC address of the device to unblock.",
    },
  },
  required: ["mac"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const mac = typeof args.mac === "string" ? args.mac : null;
  if (!mac) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "mac is required" },
    };
  }
  const res = await ctx.http.orchestrator.post("/api/network/firewall/unblock", { mac });
  if (isConfirmationResponse(res)) return passThroughConfirmation(res);
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "UNBLOCK_FAILED", message: `orchestrator returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "unblock_network_device",
  description:
    "Restore internet access for a previously blocked MAC. Destructive: requires user confirmation.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  // WARP-2472 — POST /api/network/firewall/unblock evaluates `unblock_device`
  // as Tier 2 and answers 202 with its own dashboard-redeemable token, so the
  // route is the single gate and the interceptor stands down.
  confirmationOwner: "route",
  handler,
};

export default tool;
