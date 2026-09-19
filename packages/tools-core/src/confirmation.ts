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

/**
 * Keys a route's 202 body may carry that are SECRETS, not explanation.
 *
 * Matched case-insensitively against the key name so a route that renames
 * `confirmationToken` to `confirm_token` is covered the day it does, rather
 * than the day someone notices.
 */
const SECRET_BODY_KEYS = /token|secret|challengeid|nonce/i;

/**
 * Strip the secrets out of a route's 202 body, keeping everything that explains
 * the pending action (`reason`, `sceneId`, `name`, `actionCount`, …).
 *
 * WHY. `details` is serialised into the MODEL's context. The orchestrator's 202
 * carries `confirmationToken` — a live single-use secret for a Tier-2 action
 * (`routes/cameras.ts`, `routes/network-firewall.routes.ts`) — so copying the
 * whole body handed the agent the approval for the write it had just asked to
 * make.
 *
 * That is not exploitable TODAY, and the reason is worth stating so nobody
 * "simplifies" this away: WARP-2472 made these tools `confirmationOwner:
 * "route"`, the route's confirm endpoint is `dashboardOnly`, `share_clip` 403s
 * the `_service:mcp` principal on the inline path, and none of the nine tools'
 * schemas accept a token field. The token reaches the model but the model has
 * nowhere to spend it.
 *
 * It is one change away from being exploitable. WARP-2762 proposes giving
 * background runs a redemption path for exactly these route-owned tokens. The
 * day that lands, an agent holding the token in its own context IS the agent
 * approving its own write — the thing WARP-2472's comment says the design
 * refuses. Redacting now means that ticket cannot quietly re-open this.
 *
 * Independent of any of that: a single-use security token has no business in a
 * transcript, a log, or whatever the corpus indexer picks up later.
 */
export function redactConfirmationSecrets(body: unknown): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (SECRET_BODY_KEYS.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export async function passThroughConfirmation(res: Response): Promise<ToolResult> {
  const body = await res.json().catch(() => ({}));
  const message =
    typeof body === "object" && body && "reason" in body && typeof body.reason === "string"
      ? body.reason
      // WARP-2179 — surface-agnostic on purpose. This text reaches a chat
      // chip, a paired desktop (ADR-014) and a parked background run alike;
      // naming one surface was wrong for the other two. Each surface renders
      // its own copy; this only has to be true everywhere.
      : "This action requires the user's confirmation before it runs. It has not been performed.";
  // The message above is read off the RAW body on purpose — `reason` is prose,
  // not a secret. Only what goes into `details`, and therefore into the model's
  // context, is redacted.
  return confirmationRequired(message, redactConfirmationSecrets(body));
}
