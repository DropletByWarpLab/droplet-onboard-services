import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { isConfirmationResponse, passThroughConfirmation } from "../../confirmation.js";

const inputSchema = {
  type: "object",
  properties: {
    mac: {
      type: "string",
      description: "MAC address of the device to block (format: AA:BB:CC:DD:EE:FF).",
    },
    name: {
      type: "string",
      description: "Optional friendly name for the block rule.",
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
  const body: Record<string, string> = { mac };
  if (typeof args.name === "string") body.name = args.name;

  const res = await ctx.http.orchestrator.post("/api/network/firewall/block", body);
  if (isConfirmationResponse(res)) return passThroughConfirmation(res);
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "BLOCK_FAILED", message: `orchestrator returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "block_network_device",
  description:
    "Block a device from accessing the internet by its MAC address. Destructive: requires user confirmation in the Droplet dashboard.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  // WARP-2472 — POST /api/network/firewall/block evaluates `block_device` as
  // Tier 2 and answers 202 with its own dashboard-redeemable token, so the
  // route is the single gate and the interceptor stands down.
  confirmationOwner: "route",
  handler,
};

export default tool;
