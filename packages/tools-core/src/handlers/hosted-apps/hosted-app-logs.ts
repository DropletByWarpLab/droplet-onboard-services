import type { Tool, ToolContext, ToolResult } from "../../types.js";

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) return { ok: false, status: "error", error: { code: "NO_PRINCIPAL", message: "No acting user." } };
  const slug = typeof args.slug === "string" ? args.slug : "";
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(slug)) return { ok: false, status: "error", error: { code: "INVALID_ARGS", message: "slug must identify a hosted app." } };
  const qs = new URLSearchParams({ onBehalfOf: ctx.userId });
  const res = await ctx.http.orchestrator.get(`/api/hosted/${encodeURIComponent(slug)}/logs?${qs}`, { headers: { Accept: "application/json" } });
  if (!res.ok) return { ok: false, status: "error", error: { code: "HOSTED_APP_LOGS_FAILED", message: `orchestrator returned ${res.status}` } };
  return { ok: true, data: await res.json() };
}

const hostedAppLogs: Tool = {
  name: "hosted_app_logs",
  description: "Bounded app stdout/stderr; owner/admin only.",
  inputSchema: { type: "object", properties: { slug: { type: "string", description: "App slug from list_hosted_apps." } }, required: ["slug"], additionalProperties: false },
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};
export default hostedAppLogs;
