import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: { creation: { type: "boolean", description: "Creation readiness." } }, additionalProperties: false } as const;

// The orchestrator's rolled-up snapshot lives at GET /api/orchestrator/health
// (apps/orchestrator/src/routes/health.ts) — same shape the dashboard's
// health pill reads. mcp-server's createHttpClient auto-injects a service-
// principal JWT on the `orchestrator` target.
async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (args.creation !== undefined && typeof args.creation !== "boolean") return { ok: false, status: "error", error: { code: "INVALID_ARGS", message: "creation must be a boolean" } };
  if (args.creation === true) {
    if (!ctx.userId) return { ok: false, status: "error", error: { code: "AUTH_REQUIRED", message: "Creation readiness requires an acting person." } };
    const result = await ctx.http.orchestrator.get("/api/capabilities/creation", { headers: { Accept: "application/json", "X-Nextcloud-User": ctx.userId }, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    if (!result.ok) return { ok: false, status: "error", error: { code: "HEALTH_FAILED", message: `creation readiness returned ${result.status}` } };
    return { ok: true, data: await result.json() };
  }
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
    "Live health; creation=true checks creation/research readiness.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
