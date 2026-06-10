import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

interface RawLease {
  macaddr?: string;
  ipaddr?: string;
  hostname?: string;
  expire?: number | string;
}

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const res = await ctx.http.orchestrator.get("/api/network/dhcp/leases", { headers: { Accept: "application/json" } });
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "ROUTING_UNAVAILABLE", message: `orchestrator returned ${res.status}` },
    };
  }
  const body = (await res.json()) as { leases?: RawLease[] } | RawLease[];
  const leases = Array.isArray(body) ? body : Array.isArray(body?.leases) ? body.leases : [];
  return {
    ok: true,
    data: {
      leases: leases.map((l) => ({
        mac: l.macaddr ?? null,
        ip: l.ipaddr ?? null,
        hostname: l.hostname ?? null,
        expires: l.expire ?? null,
      })),
    },
  };
}

const tool: Tool = {
  name: "list_dhcp_leases",
  description:
    "Return the router's live DHCP lease table. Useful for current IPs that haven't yet been correlated with the device database (e.g. a camera that just joined the cameras VLAN).",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
