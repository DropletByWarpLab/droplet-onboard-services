import type { Tool, ToolContext, ToolResult } from "../../types.js";

/**
 * WARP-1462 (phantom-target class): route through the orchestrator's
 * `/api/switch/ports` proxy instead of the switch service (:8081) directly.
 * The switch service's `ServiceAuthMiddleware` 403s every bearer-less call,
 * and `ctx.http.switchSvc` injects none — so this tool always 403'd. The
 * mcp-server's `createHttpClient` auto-injects the service-principal bearer
 * for the `orchestrator` target, and the read route is open to every auth
 * role (the safety/RBAC gate only applies to writes).
 *
 * Wire-shape change: the raw switch service `/ports` returns `{ ports: [...] }`;
 * the orchestrator's `/api/switch/ports` returns the aggregated, dashboard-
 * canonical `SwitchPort[]` (a BARE array — link/speed/VLAN/PoE/role joined).
 * `data` is now that array.
 */
async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const res = await ctx.http.orchestrator.get("/api/switch/ports", { headers: { Accept: "application/json" } });
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
  name: "get_switch_ports",
  description:
    // WARP-2165: this used to assert "8 copper PoE ports (1-8) and 2 SFP " +
    // "uplinks (9-10)" — the layout of one variant. State no port inventory
    // here at all: the response IS the inventory, so it stays correct on
    // whatever hardware a unit ships with.
    "Get the status of all ports on the managed PoE switch, including link state, speed, VLAN assignment, and PoE power delivery. Port count and layout vary by switch model — read them from the response rather than assuming a fixed set; each port reports whether it is an SFP/optical port.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
