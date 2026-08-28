import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { isConfirmationResponse, passThroughConfirmation } from "../../confirmation.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const res = await ctx.http.orchestrator.post("/api/network/system/reboot", {});
  if (isConfirmationResponse(res)) return passThroughConfirmation(res);
  if (res.status === 403) {
    const body = await res.json().catch(() => ({}));
    const reason =
      typeof body === "object" && body && "error" in body && typeof body.error === "string"
        ? body.error
        : "Reboot is blocked or requires owner-level access.";
    return {
      ok: false,
      status: "error",
      error: { code: "REBOOT_BLOCKED", message: reason },
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "REBOOT_FAILED", message: `orchestrator returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "restart_router",
  description:
    "Reboot the router. Drops all connected devices for 30–90 seconds while it restarts. Owner-only. May require a confirmation step in the Droplet dashboard.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  // WARP-2472 — POST /api/network/system/reboot evaluates `reboot` as Tier 3
  // and answers 202 with its own dashboard-redeemable token, so the route is
  // the single gate and the interceptor stands down.
  confirmationOwner: "route",
  handler,
};

export default tool;
