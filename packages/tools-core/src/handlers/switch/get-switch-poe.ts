import type { Tool, ToolContext, ToolResult } from "../../types.js";

/**
 * WARP-1462 (phantom-target class): route through the orchestrator's
 * `/api/switch/poe` proxy instead of the switch service (:8081) directly —
 * `ctx.http.switchSvc` sends no bearer and the switch service 403s. The
 * orchestrator target auto-injects the service-principal bearer; this read
 * route is open to every auth role.
 *
 * Wire shape is preserved: the raw switch service `/poe` returns
 * `{ ports: [...] }` and the orchestrator's `/api/switch/poe` also returns
 * `{ ports: [...] }` (the per-port mW rows), so `data` is unchanged.
 */
async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const res = await ctx.http.orchestrator.get("/api/switch/poe", { headers: { Accept: "application/json" } });
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
  name: "get_switch_poe",
  description:
    "Get PoE power-delivery status for all ports on the managed switch. Shows power draw in milliwatts, PoE class, and delivery state.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
