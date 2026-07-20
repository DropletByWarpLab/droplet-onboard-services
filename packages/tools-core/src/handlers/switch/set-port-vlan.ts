import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { isConfirmationResponse, passThroughConfirmation } from "../../confirmation.js";
import { annotateDryRun } from "./dry-run.js";

/**
 * WARP-1462 (phantom-target class): route through the orchestrator's
 * `POST /api/switch/vlans/:vlanId/membership` proxy instead of the switch
 * service (:8081) directly — `ctx.http.switchSvc` sends no bearer and the
 * switch service 403s every call. The orchestrator target auto-injects the
 * service-principal bearer; the write route admits `_service:mcp`
 * (requireRoleOrMcpService). Request body (`{ ports }`) and the plan-only
 * annotation are unchanged; a Tier-2 202 confirmation envelope from the
 * orchestrator is passed through as `confirmation_required`.
 */
const inputSchema = {
  type: "object",
  properties: {
    vlan_id: { type: "integer", description: "VLAN ID to assign (2-4094)." },
    ports: {
      type: "array",
      items: {
        type: "object",
        properties: {
          port: { type: "integer" },
          tagged: { type: "boolean" },
          member: { type: "boolean" },
        },
      },
      description: "Port membership list.",
    },
  },
  required: ["vlan_id", "ports"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const vlanId = typeof args.vlan_id === "number" ? Math.floor(args.vlan_id) : null;
  if (vlanId === null || vlanId < 2 || vlanId > 4094) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "vlan_id must be 2-4094" },
    };
  }
  if (!Array.isArray(args.ports)) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "ports must be an array" },
    };
  }
  const res = await ctx.http.orchestrator.post(
    `/api/switch/vlans/${vlanId}/membership`,
    { ports: args.ports },
  );
  if (isConfirmationResponse(res)) return passThroughConfirmation(res);
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "SET_VLAN_FAILED", message: `orchestrator returned ${res.status}` },
    };
  }
  const data = await res.json();
  // WARP-1176: a plan-only (dry-run) write is NOT an applied change — make
  // that unmissable to the model instead of letting `ok: true` read as done.
  return { ok: true, data: annotateDryRun(data) };
}

const tool: Tool = {
  name: "set_port_vlan",
  description:
    "Assign one or more switch ports to a VLAN. Use tagged=true for trunk/uplink ports, false for access ports. Destructive: requires user confirmation.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
