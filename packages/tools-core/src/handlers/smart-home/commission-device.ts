/**
 * WARP-1447 / WARP-2008 — `commission_device` LLM tool.
 *
 * Pairs a Matter device onto the fabric. `requiresConfirmation: true` was
 * declared and the description promised a "Tier 2 modal", but no such gate
 * existed at either layer — `routes/matter.ts` POST `/matter/commission` calls
 * `commissionDevice(...)` directly, and the only 202 in that file is on the
 * *command* route. The tool executed on the first model-emitted call.
 *
 * The pairing code is CREDENTIAL MATERIAL. It never appears in the
 * confirmation payload, because `error.details` is echoed into the SSE stream
 * and persisted in the chat transcript. The token's fingerprint is a HASH of
 * the code (that is what `confirmationFingerprint` is for), and the prompt
 * shows only a short non-reversible tail so the human can tell two pending
 * pairings apart.
 */
import {
  confirmationFingerprint,
  confirmationRequired,
  consumeToolConfirmation,
} from "../../confirmation.js";
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const TOOL_NAME = "commission_device";

const inputSchema = {
  type: "object",
  properties: {
    pairing_code: {
      type: "string",
      description:
        "The device pairing code — either a manual code (11/21 digit number) or a QR-code payload (starts with 'MT:').",
    },
    confirmation_token: {
      type: "string",
      description:
        "Omit this. It is issued to the user for approval, not to you — you cannot read it, and a guessed or fabricated value is refused. Call without it; the tool replies confirmation_required, and the user approves from that prompt.",
    },
  },
  required: ["pairing_code"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const pairingCode = typeof args.pairing_code === "string" ? args.pairing_code : null;
  if (!pairingCode) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "pairing_code is required" },
    };
  }

  // Confirmation gate — BEFORE any fabric operation. The fingerprint hashes
  // the code; the code itself never enters the result.
  const fingerprint = confirmationFingerprint([TOOL_NAME, pairingCode]);
  if (!consumeToolConfirmation(args.confirmation_token, TOOL_NAME, fingerprint)) {
    return confirmationRequired(
      "I'd like to commission (pair) a new Matter device onto the home fabric " +
        `using the pairing code the user supplied (ref ${fingerprint.slice(0, 8)}). ` +
        "The device will join the Droplet controller and be controllable from this home. " +
        "Ask the user to approve. You cannot approve on their behalf.",
      // NO part of the pairing code, not even a tail: this message and this
      // object are echoed into the SSE stream and persisted in the chat
      // transcript. `ref` is the first bytes of the sha256 fingerprint — it
      // disambiguates two pending pairings without being reversible.
      { type: TOOL_NAME },
      { toolName: TOOL_NAME, fingerprint },
    );
  }

  try {
    const data = await ctx.matter.commission(pairingCode);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      status: "error",
      error: { code: "COMMISSION_FAILED", message: err instanceof Error ? err.message : String(err) },
    };
  }
}

const tool: Tool = {
  name: "commission_device",
  description:
    "Commission (pair) a new Matter device using its pairing code. Establishes a secure connection and adds the device to the Droplet controller. Two-step: the first call returns confirmation_required — relay it to the user, who approves from a chat prompt. Approval happens outside this conversation; you cannot approve on their behalf, and pairing never proceeds on the first call.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
