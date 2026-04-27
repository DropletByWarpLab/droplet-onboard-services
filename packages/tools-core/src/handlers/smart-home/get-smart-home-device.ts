import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    node_id: {
      type: "string",
      description: "The Matter node ID of the device (e.g. '1', '2').",
    },
  },
  required: ["node_id"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const nodeId = typeof args.node_id === "string" ? args.node_id : null;
  if (!nodeId) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "node_id is required" },
    };
  }
  const device = await ctx.matter.getDevice(nodeId);
  return { ok: true, data: device };
}

const tool: Tool = {
  name: "get_smart_home_device",
  description:
    "Get detailed information about a specific Matter device by its node ID. Returns the device name, category, state, connection status, vendor info, endpoints, and current attribute values.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
