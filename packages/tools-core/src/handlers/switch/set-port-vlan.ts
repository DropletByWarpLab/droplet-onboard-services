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
    mode: {
      type: "string",
      enum: ["merge", "replace"],
      description:
        "merge (default): add these ports to the VLAN, keeping its other " +
        "members. replace: write the VLAN's WHOLE member list — every member " +
        "not listed is removed, which on the main LAN can cut off the router, " +
        "the access point and the appliance. Only use replace when the list " +
        "is the complete intended membership.",
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
  // Audit 2026-08-06: the membership endpoint's default is `merge` (add these
  // ports, keep the VLAN's other members) because a one-port `replace` on the
  // main LAN strands the router/AP/appliance. Only forward an EXPLICIT mode —
  // omitting it lets the orchestrator apply the safe default rather than this
  // handler asserting an intent the model never expressed.
  if (args.mode !== undefined && args.mode !== "merge" && args.mode !== "replace") {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: 'mode must be "merge" or "replace"' },
    };
  }
  const res = await ctx.http.orchestrator.post(
    `/api/switch/vlans/${vlanId}/membership`,
    args.mode === undefined
      ? { ports: args.ports }
      : { ports: args.ports, mode: args.mode },
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
