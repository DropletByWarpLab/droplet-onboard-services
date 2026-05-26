import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { isConfirmationResponse, passThroughConfirmation } from "../../confirmation.js";

// WARP-446: decommission an extender AP — remove its wireless
// config and mark the row DECOMMISSIONED. Destructive because every
// device currently connected to that AP loses its association at
// reload time. Confirmation required.

const inputSchema = {
  type: "object",
  properties: {
    mac: {
      type: "string",
      description: "MAC address of the extender AP to decommission.",
    },
  },
  required: ["mac"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const mac = typeof args.mac === "string" ? args.mac : null;
  if (!mac) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "mac is required" },
    };
  }
  // Colons in MAC are RFC 3986 §3.3 unreserved in path segments;
  // no need to percent-encode.
  const res = await ctx.http.orchestrator.post(
    `/api/aps/${mac}/decommission`,
    undefined,
  );
  if (isConfirmationResponse(res)) return passThroughConfirmation(res);
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "DECOMMISSION_FAILED",
        message: `orchestrator returned ${res.status}`,
      },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "decommission_ap",
  description:
    "Remove a coverage-extender AP from the household network. Destructive: every device currently associated with that AP will be dropped at reload time and have to re-associate (either with the same AP after a fresh approval or with the main router / a different extender). Requires user confirmation.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
