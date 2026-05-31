import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { isConfirmationResponse, passThroughConfirmation } from "../../confirmation.js";

const inputSchema = {
  type: "object",
  properties: {
    scope: {
      type: "string",
      enum: ["master", "cameras", "group"],
      description:
        "What to toggle: 'master' (the whole feature on/off), 'cameras' (the camera VLAN), or 'group' (one device group — pass groupId).",
    },
    enabled: {
      type: "boolean",
      description:
        "True to block phone-home (internet/WAN egress) for the scope; false to allow it again.",
    },
    groupId: {
      type: "string",
      description: "Device group id. Required when scope is 'group'.",
    },
  },
  required: ["scope", "enabled"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const scope = args.scope;
  const enabled = args.enabled;
  if (scope !== "master" && scope !== "cameras" && scope !== "group") {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "scope must be 'master', 'cameras', or 'group'" },
    };
  }
  if (typeof enabled !== "boolean") {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "enabled must be a boolean" },
    };
  }

  let res: Response;
  if (scope === "group") {
    const groupId = typeof args.groupId === "string" ? args.groupId : null;
    if (!groupId) {
      return {
        ok: false,
        status: "error",
        error: { code: "INVALID_ARGS", message: "groupId is required when scope is 'group'" },
      };
    }
    res = await ctx.http.routing.patch(`/groups/${encodeURIComponent(groupId)}`, {
      blockPhoneHome: enabled,
    });
  } else {
    const body = scope === "cameras" ? { cameras: enabled } : { enabled };
    res = await ctx.http.routing.patch("/phone-home", body);
  }

  if (isConfirmationResponse(res)) return passThroughConfirmation(res);
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "PHONE_HOME_FAILED", message: `routing returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "set_phone_home_blocking",
  description:
    "Block or allow 'phone home' (internet/WAN egress) for IoT, camera, and smart-home devices while keeping them working on the local network and on time (NTP + local DNS stay allowed). scope 'master' toggles the whole feature, 'cameras' the camera VLAN, 'group' a single device group (pass groupId). Destructive: requires user confirmation in the Droplet dashboard.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
