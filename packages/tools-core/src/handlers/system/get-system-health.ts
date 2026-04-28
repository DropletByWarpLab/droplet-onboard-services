import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

// The orchestrator's aggregate-health endpoint lives at /api/health.
// In tools-core we route this through the routing client (which talks to
// the orchestrator) — when the MCP server runs in-proc it can be wired
// to a local handler instead.
async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const res = await ctx.http.routing.get("/health/aggregate", { headers: { Accept: "application/json" } });
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "HEALTH_FAILED", message: `health endpoint returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "get_system_health",
  description:
    "Rolled-up health of every component the orchestrator tracks: DB, Redis, MQTT, router, Frigate, ai-gateway, and so on. Use when the user asks 'is the system OK?' or wants to diagnose which service is down.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
