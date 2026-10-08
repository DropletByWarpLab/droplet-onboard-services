/**
 * WARP-3904 — `list_connections` LLM tool.
 *
 * What is connected across every family (mailbox, Google, Microsoft 365,
 * calendar feed, catalog integration) under ONE status vocabulary, plus what
 * can be added. Read-only: `GET /api/connections`, which resolves the acting
 * person's role server-side from the forwarded identity and counts box-wide
 * rows it will not list for a member.
 *
 * The orchestrator's answer is re-validated here with `parseConnectionsOverview`
 * before it reaches the model or the dashboard card: a row that fails
 * validation is dropped, not fatal, and nothing the route did not name is
 * passed through. No credential is in the overview by construction, and none
 * is added here.
 */
import { parseConnectionsOverview } from "@droplet/shared-types";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { actingHeaders, fail, gate, httpFailure, readJson } from "./_common.js";

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const refused = gate(ctx);
  if (refused) return refused;

  const res = await ctx.http.orchestrator.get("/api/connections", {
    headers: actingHeaders(ctx),
  });
  if (!res.ok) {
    return httpFailure(res.status, "CONNECTIONS_FAILED", "Droplet could not read the connections list right now");
  }

  const overview = parseConnectionsOverview(await readJson(res));
  if (!overview) {
    return fail("INTERNAL", "Droplet could not read the connections list. Retry showing connections here in this chat.");
  }
  return { ok: true, data: overview };
}

const tool: Tool = {
  name: "list_connections",
  description:
    "Show connected and available services, including email, accounts, calendars and integrations, with sync status.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
