import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { isConfirmationResponse, passThroughConfirmation } from "../../confirmation.js";

/**
 * WARP-1462 (phantom-target class): route through the orchestrator's
 * `POST /api/switch/wan/detect` proxy instead of the switch service (:8081)
 * directly — `ctx.http.switchSvc` sends no bearer and the switch service
 * 403s every call. The orchestrator target auto-injects the service-principal
 * bearer; the write route admits `_service:mcp` (requireRoleOrMcpService).
 *
 * Envelope change: `switch_wan_detect` is a Tier-2 op in the orchestrator's
 * safety tier (config/network-safety-rules.ts), so the proxy answers 202 with
 * a confirmation envelope — NOT the raw 200 the switch service returned. Pass
 * that through as `confirmation_required` (the switch service, which owns no
 * safety tier, never did). On an allowed (Tier-1) path the raw detection body
 * is forwarded unchanged, so `data` stays stable.
 */
async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const res = await ctx.http.orchestrator.post("/api/switch/wan/detect", undefined);
  if (isConfirmationResponse(res)) return passThroughConfirmation(res);
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "DETECT_FAILED", message: `orchestrator returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

const tool: Tool = {
  name: "detect_wan_port",
  description:
    "Auto-detect which switch port is the WAN uplink to the router. Checks SFP ports first, then copper ports with active links. Mutates persisted state.",
  inputSchema,
  requiresWrite: true,
  // WARP-2472 — was `false`, which contradicted the route: POST
  // /api/switch/wan/detect evaluates `switch_wan_detect` as Tier 2
  // (config/network-safety-rules.ts) and answers 202. A Tier-2 write whose
  // tool descriptor claims no confirmation is needed is the flag lying, and
  // it kept the tool out of every enumeration that derives from the flag.
  requiresConfirmation: true,
  // The route's existing Tier-2 gate is the single prompt, and always was —
  // the interceptor never gated this tool because the flag was false.
  confirmationOwner: "route",
  handler,
};

export default tool;
