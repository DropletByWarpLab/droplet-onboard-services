import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { refuseBelowNetworkMember } from "./role-gate.js";

const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const MAX_DEVICES = 200;

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const denied = refuseBelowNetworkMember(ctx);
  if (denied) return denied;
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
    // WARP-3193 PERF-13: randomised MACs grow the table without bound, and
    // every row landed in the model's context.
    take: MAX_DEVICES,
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
    "List the 200 most-recently-seen network devices the registry knows about, newest first. Returns MAC, display name, blocked flag, vendor, hostname, last IP, first/last seen timestamps.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
