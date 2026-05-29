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

// Lock-like commands always require human confirmation, regardless of
// which MCP client called the tool. Server-side enforcement so a model
// can't bypass by:
//   - using a synonym ("LOCK", "set_lock", "lock_door")
//   - stuffing the verb into `data` ({ set_locked: true })
//   - chaining `commission_device` then a non-"lock" string command
// Per PR #233 review (Romain): "lock refusal is client-side string
// matching, not server-side enforcement... real enforcement should be
// on the orchestrator side." Voice now routes through /api/llm/chat,
// so this check fires for every caller (dashboard, voice, external MCP).
//
// Returning confirmation_required (not an outright error) preserves the
// supervised-execution path: the dashboard surfaces a confirm dialog,
// the human approves, and the agent loop re-issues the same call with
// a confirmation token. This matches the matter.service.ts safety-tier
// flow for unrelated paths (extreme thermostat settings, etc.).
const LOCKLIKE_COMMAND_TOKENS = ["lock", "unlock"] as const;

function isLockLikeCommand(command: string, data?: Record<string, unknown>): boolean {
  const lc = command.toLowerCase();
  for (const token of LOCKLIKE_COMMAND_TOKENS) {
    if (lc === token || lc.includes(token)) return true;
  }
  if (data) {
    for (const [key, value] of Object.entries(data)) {
      const kl = key.toLowerCase();
      // Detect `set_locked`, `locked`, `lockState`, `lock_door`, etc.
      // We don't need to enumerate every variant — substring on a small
      // token vocabulary is enough to block the model's bypass attempts
      // while staying readable.
      if (kl.includes("lock")) return true;
      if (typeof value === "string") {
        const vl = value.toLowerCase();
        if (vl === "lock" || vl === "unlock" || vl.includes("locked")) return true;
      }
    }
  }
  return false;
}

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

  if (isLockLikeCommand(command, data)) {
    return confirmationRequired(
      "Locking or unlocking a door from voice or chat requires confirmation in the Droplet dashboard.",
      { node_id: nodeId, command, data, reason: "locklike_command" },
    );
  }

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
