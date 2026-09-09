/**
 * WARP-2352 — audit rows for the WARP-2305 confirmation interceptor.
 *
 * A confirmation nobody can review afterwards is a UI gesture. Every
 * confirmation challenge, every refused confirmation, every runtime deny
 * and every consumed confirmation writes exactly one activity row, so an
 * operator can answer "what was approved, by whom, and what was refused".
 *
 * WHY HERE. `mcp-client.service.ts` `callTool` is the single point on the
 * orchestrator side that sees every tool dispatch — it builds the `_meta`
 * that carries the confirmation token and it reads the response the
 * interceptor produced. It already writes the per-dispatch `tool_call`
 * row through `activity.singleton.ts` → `activity.service.ts` `record()`,
 * which stays the ONLY writer. This module is pure mapping; it opens no
 * second write path.
 *
 * PHI. Tool arguments routinely carry customer content and, on the
 * ERP/health surfaces, PHI. Nothing here reads `args`. The fields below
 * come from the interceptor's own `details.interceptor` block, which is
 * constructed from a fixed set of scalars — so PHI-freedom is a property
 * of the shape rather than of a redaction pass. `lib/log-redaction.ts`
 * remains the backstop, not the design (rule 19).
 */
import type { RecordParams } from "./activity.service.js";

/** Mirrors `InterceptorAuditEvent` in `@droplet/tools-core`. */
export type ConfirmationOutcome =
  | "confirmation_required"
  | "confirmation_rejected"
  | "denied"
  | "confirmed";

export interface ConfirmationAuditEvent {
  outcome: ConfirmationOutcome;
  tool: string;
  reason?: string;
}

/**
 * Pull the interceptor's machine-readable block out of a tool-call
 * response, WITHOUT pattern-matching on message prose.
 *
 * Returns null for an ordinary result — a read, or a tool-reported
 * failure that has nothing to do with the confirmation gate — so those
 * write no confirmation row.
 */
export function interceptorEventFromContent(
  content: { type: string; text?: string }[],
): ConfirmationAuditEvent | null {
  const text = content[0]?.text;
  if (typeof text !== "string" || text.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const error = (parsed as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const details = (error as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return null;
  const block = (details as { interceptor?: unknown }).interceptor;
  if (typeof block !== "object" || block === null) return null;

  const outcome = (block as { outcome?: unknown }).outcome;
  const tool = (block as { tool?: unknown }).tool;
  if (typeof outcome !== "string" || typeof tool !== "string") return null;
  if (
    outcome !== "confirmation_required" &&
    outcome !== "confirmation_rejected" &&
    outcome !== "denied"
  ) {
    return null;
  }

  const reason = (block as { reason?: unknown }).reason;
  return {
    outcome,
    tool,
    ...(typeof reason === "string" ? { reason } : {}),
  };
}

/**
 * The event for a dispatch that PRESENTED a confirmation token and
 * succeeded — the confirm-consumed case.
 *
 * It is derived on this side rather than read from the payload because a
 * successful `ToolResult` carries only `data`: adding an envelope to
 * every ok response so this one case could be read back would change the
 * wire shape for all 134 tools. The orchestrator already knows both
 * halves — it set the token on `_meta`, and it sees `isError` — so the
 * fact is available here without touching that contract.
 */
export function confirmedEvent(args: {
  tool: string;
  presentedToken: boolean;
  isError: boolean;
}): ConfirmationAuditEvent | null {
  if (!args.presentedToken || args.isError) return null;
  return { outcome: "confirmed", tool: args.tool };
}

const SEVERITY: Record<ConfirmationOutcome, RecordParams["severity"]> = {
  // A challenge is the system working as designed, not a problem.
  confirmation_required: "info",
  // A refused token is a replay, an expiry, or a bug — an operator
  // should be able to filter for it.
  confirmation_rejected: "warn",
  denied: "warn",
  confirmed: "ok",
};

const WHAT: Record<ConfirmationOutcome, (tool: string) => string> = {
  confirmation_required: (t) => `${t} needs approval`,
  confirmation_rejected: (t) => `${t} confirmation refused`,
  denied: (t) => `${t} blocked`,
  confirmed: (t) => `${t} approved and run`,
};

/**
 * Map an interceptor event onto the single activity writer's params.
 *
 * `actor.type` is `ai`: this is agent-loop / MCP tool dispatch, matching
 * the existing per-dispatch row in `mcp-client.service.ts`. `userId` is
 * the caller's USERNAME (WARP-202), not a canonical UUID, so it stays in
 * `refs` and `actorId` stays null — the recorder rejects a non-UUID under
 * actor type `user`.
 */
export function confirmationActivityParams(
  event: ConfirmationAuditEvent,
  context: { userId?: string },
): RecordParams {
  return {
    kind: "tool_call",
    severity: SEVERITY[event.outcome],
    sourceIcon: "shield-check",
    what: WHAT[event.outcome](event.tool),
    sub: context.userId ? `for ${context.userId}` : null,
    actor: { type: "ai", id: null },
    refs: {
      // Deliberately a closed set of scalars. There is no field here a
      // tool argument could be placed in.
      name: event.tool,
      confirmation: event.outcome,
      ...(event.reason ? { reason: event.reason } : {}),
      ...(context.userId ? { userId: context.userId } : {}),
      ticket: "WARP-2305",
    },
  };
}
