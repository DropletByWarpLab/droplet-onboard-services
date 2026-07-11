import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { isConfirmationResponse, passThroughConfirmation } from "../../confirmation.js";
import { annotateDryRun } from "./dry-run.js";

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
  const path = `/poe/${port}/${enabled ? "enable" : "disable"}`;
  const res = await ctx.http.switchSvc.post(path, undefined);
  if (isConfirmationResponse(res)) return passThroughConfirmation(res);
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "SET_POE_FAILED", message: `switch returned ${res.status}` },
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
  handler,
};

export default tool;
