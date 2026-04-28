import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { confirmationRequired } from "../../confirmation.js";

const inputSchema = {
  type: "object",
  properties: {
    node_id: { type: "string", description: "The Matter node ID of the device to control." },
    command: {
      type: "string",
      description:
        "Command to send: turn_on, turn_off, toggle, set_brightness, set_temperature, lock, unlock.",
    },
    data: {
      type: "object",
      description: "Optional command parameters (e.g. {brightness: 75} or {temperature: 22}).",
    },
  },
  required: ["node_id", "command"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const nodeId = typeof args.node_id === "string" ? args.node_id : null;
  const command = typeof args.command === "string" ? args.command : null;
  if (!nodeId || !command) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "node_id and command are required" },
    };
  }
  const data = args.data && typeof args.data === "object" ? (args.data as Record<string, unknown>) : undefined;
  let result: unknown;
  try {
    result = await ctx.matter.sendCommand(nodeId, command, data);
  } catch (err) {
    return {
      ok: false,
      status: "error",
      error: { code: "MATTER_COMMAND_FAILED", message: err instanceof Error ? err.message : String(err) },
    };
  }
  // The Matter service may return {status: "confirmation_required", reason}
  // for safety-tier-2 commands (locks, extreme thermostat settings). Pass
  // those through as the canonical confirmation_required ToolResult shape.
  if (
    result &&
    typeof result === "object" &&
    "status" in result &&
    (result as { status: unknown }).status === "confirmation_required"
  ) {
    const reason =
      (result as { reason?: unknown; message?: unknown }).reason ??
      (result as { reason?: unknown; message?: unknown }).message;
    return confirmationRequired(
      typeof reason === "string"
        ? reason
        : "This action requires user confirmation in the Droplet dashboard.",
      result,
    );
  }
  return { ok: true, data: result };
}

const tool: Tool = {
  name: "control_device",
  description:
    "Send a command to a smart-home device. Available commands depend on device type. Some commands (locks, extreme settings) require user confirmation and will return a confirmation_required result instead of executing immediately.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
