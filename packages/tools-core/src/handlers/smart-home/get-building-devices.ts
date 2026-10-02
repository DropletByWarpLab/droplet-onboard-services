import type { Tool, ToolContext, ToolResult } from "../../types.js";

/**
 * Device control over the device gateway (BACnet/IP, Modbus TCP, SNMP,
 * KNX/IP) — HVAC and building controllers, meters, lighting, printers, UPSes.
 *
 * No `device`: the registered devices and their points (no live reads — a
 * site can have dozens of controllers and a read is a round trip to each).
 * With `device`: that device's points joined with one live read.
 *
 * Routed through the orchestrator's `/api/building/*` (the mcp-server injects
 * the service bearer for the `orchestrator` target; the read routes admit the
 * MCP principal).
 */

interface Point {
  id: string;
  name: string;
  kind: string;
  unit?: string | null;
  writable: boolean;
  min?: number | null;
  max?: number | null;
}

interface Device {
  id: string;
  name: string;
  protocol: string;
  room?: string | null;
  points: Point[];
}

function fail(res: Response, what: string): ToolResult {
  return {
    ok: false,
    status: "error",
    error: {
      code: res.status === 404 ? "DEVICE_NOT_FOUND" : "DEVICE_GATEWAY_ERROR",
      message: `${what}: orchestrator returned ${res.status}`,
    },
  };
}

function pointMeta(p: Point) {
  return {
    id: p.id,
    name: p.name,
    unit: p.unit ?? undefined,
    writable: p.writable,
    ...(p.writable && p.kind === "number" ? { min: p.min, max: p.max } : {}),
  };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const device = typeof args.device === "string" && args.device ? args.device : null;

  if (!device) {
    const res = await ctx.http.orchestrator.get("/api/building/devices");
    if (!res.ok) return fail(res, "list devices");
    const { devices } = (await res.json()) as { devices: Device[] };
    return {
      ok: true,
      data: devices.map((d) => ({
        id: d.id,
        name: d.name,
        protocol: d.protocol,
        room: d.room ?? undefined,
        points: d.points.map(pointMeta),
      })),
    };
  }

  const id = encodeURIComponent(device);
  const metaRes = await ctx.http.orchestrator.get(`/api/building/devices/${id}`);
  if (!metaRes.ok) return fail(metaRes, `device ${device}`);
  const meta = (await metaRes.json()) as Device;
  const valRes = await ctx.http.orchestrator.get(`/api/building/devices/${id}/values`);
  if (!valRes.ok) return fail(valRes, `read ${device}`);
  const { values, read_at } = (await valRes.json()) as {
    values: Record<string, { value: unknown; error: string | null }>;
    read_at: string;
  };
  return {
    ok: true,
    data: {
      id: meta.id,
      name: meta.name,
      protocol: meta.protocol,
      read_at,
      points: meta.points.map((p) => ({
        ...pointMeta(p),
        value: values[p.id]?.value ?? null,
        ...(values[p.id]?.error ? { error: values[p.id].error } : {}),
      })),
    },
  };
}

const inputSchema = {
  type: "object",
  properties: {
    device: { type: "string", description: "Device id; omit to list all devices" },
  },
  additionalProperties: false,
} as const;

const tool: Tool = {
  name: "get_building_devices",
  description:
    "Building systems on BACnet, Modbus, SNMP or KNX (HVAC, meters, lighting, printers, UPS). Without device: list devices and points. With device: read its live values.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
