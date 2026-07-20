import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const devices = await ctx.matter.listDevices();
  return { ok: true, data: devices };
}

const tool: Tool = {
  name: "list_smart_home_devices",
  description:
    "List all smart home devices connected via Matter, grouped by category (lights, switches, sensors, climate, media, covers, locks, other). Includes state, connection status, and attributes. Each device also carries the household's own names when set: `friendlyName` (what the user calls it, e.g. \"kitchen strip\") and `roomName` (the room it's in, e.g. \"Kitchen\"). To act on a request like \"turn off the kitchen lights\" or \"dim the bedroom lamp\", match against these names to find the device's `nodeId`, then call control_device with it.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
