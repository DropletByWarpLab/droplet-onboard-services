import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  // WARP-106: `isBlocked` is no longer a stored column. Select the two
  // authored block fields and expose a computed, always-boolean
  // `isBlocked = (lastAppliedBlocked ?? manualBlock)` — `lastAppliedBlocked`
  // (ticker-authored effective state) is the source of truth, falling back
  // to `manualBlock` (user intent) before the ticker has run. The raw
  // authored fields stay internal; the tool surfaces only the flag.
  const rows = await ctx.prisma.networkDevice.findMany({
    select: {
      mac: true,
      displayName: true,
      lastAppliedBlocked: true,
      manualBlock: true,
      vendor: true,
      hostname: true,
      lastIp: true,
      firstSeen: true,
      lastSeen: true,
    },
    orderBy: { lastSeen: "desc" },
  });
  const devices = rows.map(({ lastAppliedBlocked, manualBlock, ...rest }) => ({
    ...rest,
    isBlocked: lastAppliedBlocked ?? manualBlock,
  }));
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
