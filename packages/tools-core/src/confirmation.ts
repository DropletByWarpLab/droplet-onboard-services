/**
 * Handler-side helpers for the two-phase write contract.
 *
 * READ THIS BEFORE WRITING A CONFIRMING TOOL (WARP-2305).
 *
 * `requiresConfirmation` is now enforced GENERICALLY, in the dispatch
 * path, by the interceptor in `./interceptor.ts`. You do NOT need to
 * write confirmation code: set `requiresConfirmation: true` on the tool
 * and the interceptor refuses the first call, mints a token bound to the
 * tool name and arguments, and runs your handler only once that token
 * comes back. A handler with no confirmation code at all is fully gated.
 *
 * That was not true before WARP-2305, which is why 37 tools call
 * `confirmationRequired()` below by hand — and why 19 of those 37 had no
 * check at all and wrote on the first call. Do not add a 38th copy of the
 * four-line pattern merely to satisfy the flag.
 *
 * `confirmationRequired()` is still the right tool when the DECISION is
 * domain-specific rather than generic — `control_device` refusing lock
 * commands outright, `memory_forget` echoing the fact text the user must
 * approve. Those still run, and the interceptor does not double-prompt
 * them: when it verifies a token for a tool whose input schema declares
 * `confirmed`, it sets `confirmed: true` on the arguments your handler
 * receives, so your own `args.confirmed !== true` gate passes.
 *
 * Full contract: `docs/tool-confirmation-contract.md`.
 */
import type { ToolResult } from "./types.js";

export function confirmationRequired(message: string, details?: unknown): ToolResult {
  return {
    ok: false,
    status: "confirmation_required",
    error: {
      code: "CONFIRMATION_REQUIRED",
      message,
      details,
    },
  };
}

export function isConfirmationResponse(res: Response): boolean {
  return res.status === 202;
}

export async function passThroughConfirmation(res: Response): Promise<ToolResult> {
  const body = await res.json().catch(() => ({}));
  const message =
    typeof body === "object" && body && "reason" in body && typeof body.reason === "string"
      ? body.reason
      : "This action requires user confirmation in the Droplet dashboard.";
  return confirmationRequired(message, body);
}
