import type { Tool, ToolContext, ToolResult } from "../../types.js";

// WARP-446: read-only tool that surfaces the ApDevice registry so the
// LLM agent can answer questions like "is the upstairs AP still
// online" or "which extender hasn't been seen in a while". Reads
// directly from Prisma — same pattern as `list_network_devices`.
//
// No filtering args yet — when we add per-status filtering we'll do
// it as an optional `status` enum here, mirroring the orchestrator
// route's `?status=` shape.

const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aps = await (ctx.prisma as any).apDevice.findMany({
    select: {
      mac: true,
      displayName: true,
      status: true,
      model: true,
      serial: true,
      version: true,
      lastIp: true,
      hostname: true,
      firstSeen: true,
      lastSeen: true,
      approvedAt: true,
      approvedBy: true,
      approvedSsid: true,
      decommissionedAt: true,
      failureReason: true,
    },
    orderBy: { lastSeen: "desc" },
  });
  return { ok: true, data: { aps } };
}

const tool: Tool = {
  name: "list_ap_devices",
  description:
    "List every coverage-extender AP the orchestrator knows about, ordered by most-recently-seen. Returns MAC, display name, status (DISCOVERED/AWAITING_APPROVAL/PROVISIONING/ONLINE/FAILED/DECOMMISSIONED), model, version, IP, and approval/decommission audit columns.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
