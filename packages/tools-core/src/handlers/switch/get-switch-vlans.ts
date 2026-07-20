import type { Tool, ToolContext, ToolResult } from "../../types.js";

/**
 * WARP-1462 (phantom-target class): route through the orchestrator's
 * `/api/switch/vlans` proxy instead of the switch service (:8081) directly —
 * `ctx.http.switchSvc` sends no bearer and the switch service 403s. The
 * orchestrator target auto-injects the service-principal bearer; this read
 * route is open to every auth role.
 *
 * Wire-shape change: the raw switch service `/vlans` returns `{ vlans: [...] }`;
 * the orchestrator's `/api/switch/vlans` returns the aggregated, dashboard-
 * canonical `SwitchVlan[]` (a BARE array of `{ vlan_id, name, isolated, ports[] }`).
 * `data` is now that array.
 */
async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const res = await ctx.http.orchestrator.get("/api/switch/vlans", { headers: { Accept: "application/json" } });
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "SWITCH_UNAVAILABLE", message: `orchestrator returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

const tool: Tool = {
  name: "get_switch_vlans",
  description: "List all VLANs configured on the managed switch with their port memberships.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
