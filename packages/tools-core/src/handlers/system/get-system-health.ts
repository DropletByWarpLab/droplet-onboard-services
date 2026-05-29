import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

// The orchestrator's rolled-up snapshot lives at GET /api/orchestrator/health
// (apps/orchestrator/src/routes/health.ts) — same shape the dashboard's
// health pill reads. mcp-server's createHttpClient auto-injects a service-
// principal JWT on the `orchestrator` target.
async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const res = await ctx.http.orchestrator.get("/api/orchestrator/health", { headers: { Accept: "application/json" } });
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
