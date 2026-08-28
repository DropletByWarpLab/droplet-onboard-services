/**
 * WARP-1443 — `set_wifi_password` LLM tool.
 *
 * Changes the household Wi-Fi (WPA2-PSK) password via the
 * orchestrator's `POST /api/network/wifi/password` route (body
 * `{ password }`; the route defaults `iface_section` to
 * "default_radio0" and runs the network-safety evaluator, which may
 * answer 202 + confirmation token on its own Tier-2 arm).
 *
 * Tier 2 (write + requires confirmation), enforced BY THE HANDLER —
 * same two-phase contract as `memory_forget` / `set_detection_zones`:
 * the first call returns `confirmation_required` (no HTTP); the model
 * relays it and re-issues with `confirmed: true` only after an explicit
 * user yes.
 *
 * SECRECY INVARIANT: the password value NEVER appears in any
 * ToolResult — not in the confirmation echo, not in success data, not
 * in error messages. Validation errors name the WPA2-PSK rule (8-63
 * printable ASCII characters) without quoting the rejected value.
 */
import {
  confirmationRequired,
  isConfirmationResponse,
  passThroughConfirmation,
} from "../../confirmation.js";
import type { Tool, ToolContext, ToolResult } from "../../types.js";

/** WPA2-PSK passphrase rule (IEEE 802.11i): 8-63 printable ASCII chars. */
const WPA2_PSK_RE = /^[\x20-\x7e]{8,63}$/;

const inputSchema = {
  type: "object",
  properties: {
    password: {
      type: "string",
      description:
        "The new Wi-Fi password (WPA2-PSK passphrase): 8-63 printable ASCII characters. It is applied but never echoed back in any response.",
    },
    confirmed: {
      type: "boolean",
      description:
        "Set true ONLY after the user has explicitly approved changing the Wi-Fi password in this conversation. Omit (or set false) on the first call — the tool will reply confirmation_required with a prompt to relay to the user.",
    },
  },
  required: ["password"],
  additionalProperties: false,
} as const;

function invalidPassword(message: string): ToolResult {
  return { ok: false, status: "error", error: { code: "INVALID_PASSWORD", message } };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const password = typeof args.password === "string" ? args.password : "";
  if (!WPA2_PSK_RE.test(password)) {
    // Name the rule, never the value.
    return invalidPassword(
      "Wi-Fi password must be 8-63 printable ASCII characters (WPA2-PSK rule) — " +
        "no control characters or non-ASCII letters.",
    );
  }

  // Confirmation gate — AFTER validation, BEFORE any HTTP. The echo
  // says WHAT happens (every device must reconnect) without ever
  // carrying the password itself.
  if (args.confirmed !== true) {
    return confirmationRequired(
      "I'd like to set a new Wi-Fi password for the household network. " +
        "EVERY connected device — phones, laptops, cameras, smart-home gear — will be " +
        "disconnected and must reconnect with the new password. " +
        "Ask the user to approve, then re-issue this call with confirmed: true. " +
        "Do NOT set confirmed: true without an explicit yes from the user.",
      { type: "set_wifi_password" }, // deliberately no password field
    );
  }

  const res = await ctx.http.orchestrator.post("/api/network/wifi/password", { password });
  if (isConfirmationResponse(res)) return passThroughConfirmation(res);
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const serverMsg = errBody && typeof errBody.error === "string" ? errBody.error : null;
    if (res.status === 400) {
      return invalidPassword(serverMsg ?? "orchestrator rejected the password");
    }
    return {
      ok: false,
      status: "error",
      error: {
        code: "WIFI_PASSWORD_FAILED",
        message: serverMsg ?? `orchestrator returned ${res.status}`,
      },
    };
  }

  // Success shape is fixed and password-free.
  return { ok: true, data: { type: "set_wifi_password", changed: true } };
}

const tool: Tool = {
  name: "set_wifi_password",
  description:
    "Change the household Wi-Fi password (WPA2-PSK, 8-63 printable ASCII characters). " +
    "EVERY connected device is disconnected and must reconnect with the new password. " +
    "Two-step: the first call returns confirmation_required — relay it to the user, and only " +
    "after they explicitly approve, re-issue the SAME call with confirmed: true. " +
    "The password value is never echoed back in any response.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  // WARP-2472 — POST /api/network/wifi/password evaluates `set_wifi_password`
  // as Tier 2 and answers 202 with its own dashboard-redeemable token, so the
  // route is the single gate and the interceptor stands down. This tool also
  // keeps its own `args.confirmed` gate, which predates the interceptor.
  confirmationOwner: "route",
  handler,
};

export default tool;
