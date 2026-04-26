import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const devices = await ctx.prisma.networkDevice.findMany({
    select: {
      mac: true,
      displayName: true,
      isBlocked: true,
      vendor: true,
      hostname: true,
      lastIp: true,
      firstSeen: true,
      lastSeen: true,
    },
    orderBy: { lastSeen: "desc" },
  });
  return { ok: true, data: { devices } };
}

const tool: Tool = {
  name: "list_network_devices",
  description:
    "List every network device the registry knows about, ordered by most-recently-seen. Returns MAC, display name, blocked flag, vendor, hostname, last IP, first/last seen timestamps.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
