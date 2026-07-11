import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { isConfirmationResponse, passThroughConfirmation } from "../../confirmation.js";
import { annotateDryRun } from "./dry-run.js";

const inputSchema = {
  type: "object",
  properties: {
    vlan_id: { type: "integer", description: "VLAN ID for cameras (default: 100)." },
    camera_ports: {
      type: "array",
      items: { type: "integer" },
      description: "Ports for cameras (default: [1,2,3,4,5,6,7,8]).",
    },
    uplink_ports: {
      type: "array",
      items: { type: "integer" },
      description: "Trunk/uplink ports (default: [9,10]).",
    },
  },
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const body: Record<string, unknown> = {};
  if (typeof args.vlan_id === "number") body.vlan_id = Math.floor(args.vlan_id);
  if (Array.isArray(args.camera_ports)) body.camera_ports = args.camera_ports;
  if (Array.isArray(args.uplink_ports)) body.uplink_ports = args.uplink_ports;

  const res = await ctx.http.switchSvc.post("/setup/cameras", body);
  if (isConfirmationResponse(res)) return passThroughConfirmation(res);
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "SETUP_FAILED", message: `switch returned ${res.status}` },
    };
  }
  const data = await res.json();
  // WARP-1176: a plan-only (dry-run) write is NOT an applied change — make
  // that unmissable to the model instead of letting `ok: true` read as done.
  return { ok: true, data: annotateDryRun(data) };
}

const tool: Tool = {
  name: "setup_camera_ports",
  description:
    "One-click setup: create a camera VLAN on the switch and assign ports. Camera ports get untagged access, uplink ports get tagged trunk. Destructive: requires user confirmation.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
