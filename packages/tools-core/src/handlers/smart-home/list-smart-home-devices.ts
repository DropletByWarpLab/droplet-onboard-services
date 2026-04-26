import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const devices = await ctx.matter.listDevices();
  return { ok: true, data: devices };
}

const tool: Tool = {
  name: "list_smart_home_devices",
  description:
    "List all smart home devices connected via Matter, grouped by category (lights, switches, sensors, climate, media, covers, locks, other). Includes state, connection status, and attributes.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
