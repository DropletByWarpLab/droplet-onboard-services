import type { Tool, ToolContext, ToolResult } from "../../types.js";

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) return { ok: false, status: "error", error: { code: "NO_PRINCIPAL", message: "No acting user." } };
  const qs = new URLSearchParams({ onBehalfOf: ctx.userId });
  const limit = typeof args.limit === "number" && Number.isInteger(args.limit) ? args.limit : 20;
  if (limit < 1 || limit > 50) return { ok: false, status: "error", error: { code: "INVALID_ARGS", message: "limit must be 1–50." } };
  qs.set("limit", String(limit));
  if (typeof args.cursor === "string") qs.set("cursor", args.cursor);
  const res = await ctx.http.orchestrator.get(`/api/hosted?${qs}`, { headers: { Accept: "application/json" } });
  if (!res.ok) return { ok: false, status: "error", error: { code: "HOSTED_APPS_READ_FAILED", message: `orchestrator returned ${res.status}` } };
  return { ok: true, data: await res.json() };
}

const listHostedApps: Tool = {
  name: "list_hosted_apps",
  description: "List permitted hosted web apps: status and URL.",
  inputSchema: { type: "object", properties: { limit: { type: "integer", description: "Page size, default 20." }, cursor: { type: "string", description: "Previous nextCursor." } }, additionalProperties: false },
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};
export default listHostedApps;
