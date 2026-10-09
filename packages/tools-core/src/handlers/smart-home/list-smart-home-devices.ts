import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const devices = await ctx.matter.listDevices();
  return { ok: true, data: devices };
}

const tool: Tool = {
  name: "list_smart_home_devices",
  description:
    "List Matter devices by category with state/status/attributes. Match friendlyName and roomName to user wording, then use resolved nodeId with control_device; never guess.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
