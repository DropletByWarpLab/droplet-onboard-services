import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { isConfirmationResponse, passThroughConfirmation } from "../../confirmation.js";

/**
 * WARP-1462 (phantom-target class): route through the orchestrator's
 * `POST /api/switch/wan/detect` proxy instead of the switch service (:8081)
 * directly — `ctx.http.switchSvc` sends no bearer and the switch service
 * 403s every call. The orchestrator target auto-injects the service-principal
 * bearer; the write route admits `_service:mcp` (requireRoleOrMcpService).
 *
 * Envelope: `switch_wan_detect` is Tier 1 in the orchestrator's safety tier
 * (config/network-safety-rules.ts — WARP-2125 dropped it below Tier 2 because
 * detection is a pure read that writes nothing), so the allowed path answers
 * a direct 200 and the raw detection body is forwarded unchanged. The
 * `isConfirmationResponse` passthrough below is kept as defensive handling:
 * if the operation ever gets confirm-gated again, the tool surfaces
 * `confirmation_required` instead of mistaking the envelope for detection data.
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
    "Auto-detect which switch port is the WAN uplink to the router. Checks SFP ports first, then copper ports with active links. Read-only: reports the detected port, changes nothing.",
  inputSchema,
  // Deliberately UNCHANGED by WARP-2125 (which corrected the description and
  // the orchestrator's tier): flipping this alters the orchestrator's derived
  // WRITE_TOOLS gating and is a separate decision — flagged as a follow-up.
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
