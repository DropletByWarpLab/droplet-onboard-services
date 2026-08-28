import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { isConfirmationResponse, passThroughConfirmation } from "../../confirmation.js";
import { annotateDryRun } from "./dry-run.js";

/**
 * WARP-1462 (phantom-target class): route through the orchestrator's
 * `POST /api/switch/poe/:port/enable|disable` proxy instead of the switch
 * service (:8081) directly — `ctx.http.switchSvc` sends no bearer and the
 * switch service 403s every call. The orchestrator target auto-injects the
 * service-principal bearer; the write route admits `_service:mcp`
 * (requireRoleOrMcpService). The Tier-2 safety tier now lives on the
 * orchestrator side, so a 202 confirmation envelope is possible here (the
 * switch service never minted one); `passThroughConfirmation` handles it.
 * On the allowed path the payload is annotated for plan-only writes as before.
 */
const inputSchema = {
  type: "object",
  properties: {
    port: { type: "integer", description: "Port number (1-8, copper PoE ports only)." },
    enabled: { type: "boolean", description: "True to enable PoE, false to disable." },
  },
  required: ["port", "enabled"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const port = typeof args.port === "number" ? Math.floor(args.port) : null;
  const enabled = typeof args.enabled === "boolean" ? args.enabled : null;
  if (port === null || port < 1 || port > 8) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "port must be 1-8 (copper PoE only)" },
    };
  }
  if (enabled === null) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "enabled is required" },
    };
  }
  const path = `/api/switch/poe/${port}/${enabled ? "enable" : "disable"}`;
  const res = await ctx.http.orchestrator.post(path, undefined);
  if (isConfirmationResponse(res)) return passThroughConfirmation(res);
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "SET_POE_FAILED", message: `orchestrator returned ${res.status}` },
    };
  }
  const data = await res.json();
  // WARP-1176: a plan-only (dry-run) write is NOT an applied change — make
  // that unmissable to the model instead of letting `ok: true` read as done.
  return { ok: true, data: annotateDryRun(data) };
}

const tool: Tool = {
  name: "set_port_poe",
  description:
    "Enable or disable PoE power on a switch port (ports 1-8 only, not SFP). Destructive: requires user confirmation.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  // WARP-2472 — POST /api/switch/poe/:port/{enable,disable} evaluates
  // `switch_poe_enable` / `switch_poe_disable` as Tier 2 and answers 202 with
  // its own dashboard-redeemable token, so the route is the single gate and
  // the interceptor stands down.
  confirmationOwner: "route",
  handler,
};

export default tool;
