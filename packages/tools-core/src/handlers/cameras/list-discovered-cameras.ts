import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

interface CameraRow {
  id: string;
  name: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  manufacturer: string | null;
  model: string | null;
  createdAt: Date;
}

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const pending = (await ctx.prisma.camera.findMany({
    where: { enabled: false, autoDiscovered: true },
    orderBy: { createdAt: "desc" },
    take: 20,
  })) as unknown as CameraRow[];
  return {
    ok: true,
    data: {
      pending: pending.map((c) => ({
        id: c.id,
        name: c.name,
        ip: c.ipAddress,
        mac: c.macAddress,
        manufacturer: c.manufacturer,
        model: c.model,
        discovered_at: c.createdAt.toISOString(),
      })),
    },
  };
}

const tool: Tool = {
  name: "list_discovered_cameras",
  description:
    "List IP cameras the camera-discovery service has found on the cameras VLAN but that have NOT yet been accepted into Frigate. Use accept_discovered_camera to add one.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
