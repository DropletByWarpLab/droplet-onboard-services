import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    pairing_code: {
      type: "string",
      description:
        "The device pairing code — either a manual code (11/21 digit number) or a QR-code payload (starts with 'MT:').",
    },
  },
  required: ["pairing_code"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const pairingCode = typeof args.pairing_code === "string" ? args.pairing_code : null;
  if (!pairingCode) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "pairing_code is required" },
    };
  }
  try {
    const data = await ctx.matter.commission(pairingCode);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      status: "error",
      error: { code: "COMMISSION_FAILED", message: err instanceof Error ? err.message : String(err) },
    };
  }
}

const tool: Tool = {
  name: "commission_device",
  description:
    "Commission (pair) a new Matter device using its pairing code. Establishes a secure connection and adds the device to the Droplet controller. After commissioning, the device will appear in list_smart_home_devices.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
