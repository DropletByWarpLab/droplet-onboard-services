/**
 * WARP-2305 — the generic write-confirmation interceptor and the runtime
 * deny tier.
 *
 * WHY THIS EXISTS. `requiresConfirmation` was declarative metadata that
 * nothing enforced generically; `handlers/memory/forget.ts` said so in
 * the tree. Enforcement was 37 independent copies of a four-line check —
 * and 19 of the 37 did not have one (see
 * `docs/tool-confirmation-contract.md` §7). A tool we did not author (a
 * remote MCP tool under WARP-320) has no handler of ours at all, so
 * handler-side enforcement cannot work for that class even in principle.
 *
 * WHERE IT RUNS. `services/mcp-server/src/server.ts` is the only site in
 * the repo that calls `tool.handler(...)`, and both the in-process agent
 * loop and external MCP clients reach it. Intercepting there covers both
 * with ONE implementation. This module holds the logic so it is
 * transport-agnostic and testable without a server.
 *
 * The interceptor runs BEFORE the handler: a refused call never reaches
 * handler code.
 */
import {
  createConfirmationTokenStore,
  type ConfirmationRedeemFailure,
  type ConfirmationTokenStore,
} from "./confirmation-token.js";
import type { ToolResult } from "./types.js";

/**
 * The minimum a tool must declare to be intercepted.
 *
 * Deliberately NOT `Tool`: a remote MCP tool under WARP-320 has no
 * handler of ours and is not in `registry.ts`, but it does declare a name
 * and a confirmation flag. Registry membership is not required — that is
 * the whole point of a dispatch-time gate.
 */
export interface InterceptableTool {
  name: string;
  requiresConfirmation: boolean;
  requiresWrite?: boolean;
  inputSchema?: unknown;
}

export interface DenyReason {
  /** Machine-readable. Callers switch on this, never on the message. */
  code: string;
  message: string;
}

/** Returns a reason to refuse, or `null` to allow. */
export type DenyRule = (input: {
  tool: InterceptableTool;
  args: Record<string, unknown>;
}) => DenyReason | null;

/**
 * WARP-2328 — the runtime deny tier.
 *
 * REMIT, deliberately narrow: this tier governs **runtime arrivals and
 * runtime conditions only**. It is NOT a mirror of `registry.ts`
 * absence.
 *
 * "Destructive actions are blocked" is implemented first and foremost by
 * a tool not existing in the compile-time registry array, and
 * `__tests__/storage-pool-tools.test.ts` remains that guarantee's test.
 * That control is complete for tools we choose never to write. It has
 * nothing to say about a tool that exists at runtime — an MCP tool from a
 * remote server, or a registry tool that must be refused under some
 * condition. This tier covers exactly that gap and no more. Two
 * mechanisms disagreeing about what "blocked" means would be worse than
 * one, so do not re-list here what compile-time absence already excludes.
 *
 * It ships EMPTY. Deciding *which* actions are destructive is a human
 * decision and a separate ticket (WARP-2305 "Out of scope"); this builds
 * the tier, not the membership list.
 */
export interface RuntimeDenyTier {
  /** Register a rule under a stable id. Re-registering an id replaces it. */
  add(id: string, rule: DenyRule): void;
  remove(id: string): boolean;
  clear(): void;
  /** First matching rule wins; `null` means no rule objected. */
  evaluate(tool: InterceptableTool, args: Record<string, unknown>): DenyReason | null;
  ids(): string[];
}

export function createRuntimeDenyTier(): RuntimeDenyTier {
  const rules = new Map<string, DenyRule>();
  return {
    add(id, rule) {
      rules.set(id, rule);
    },
    remove(id) {
      return rules.delete(id);
    },
    clear() {
      rules.clear();
    },
    evaluate(tool, args) {
      for (const rule of rules.values()) {
        const reason = rule({ tool, args });
        if (reason) return reason;
      }
      return null;
    },
    ids() {
      return [...rules.keys()];
    },
  };
}

/**
 * The dispatch-time decision. A discriminated union rather than an error
 * string, so callers never pattern-match prose (WARP-2312).
 */
export type InterceptOutcome =
  | {
      kind: "proceed";
      /** Arguments to hand the handler — see `confirmationConsumed`. */
      args: Record<string, unknown>;
      /** True when a token was verified and spent for this call. */
      confirmationConsumed: boolean;
    }
  | { kind: "denied"; reason: DenyReason }
  | { kind: "confirmation_required"; token: string; expiresAt: number }
  | { kind: "confirmation_rejected"; reason: ConfirmationRedeemFailure };

/** Per-call protocol metadata. On MCP this is `req.params._meta`. */
export interface InterceptMeta {
  confirmationToken?: string;
}

export interface ToolCallInterceptor {
  intercept(
    tool: InterceptableTool,
    args: Record<string, unknown>,
    meta?: InterceptMeta,
    now?: number,
  ): InterceptOutcome;
  readonly tokens: ConfirmationTokenStore;
  readonly denyTier: RuntimeDenyTier;
}

/**
 * Does this tool's input schema declare a `confirmed` property?
 *
 * Used to decide whether to normalise `confirmed: true` onto the
 * arguments of a call whose token verified — see `intercept`. Detected
 * from the schema rather than from a list of tool names, so a 38th
 * confirming tool is handled the day it is added and no parallel list can
 * drift (the WARP-2345 rule, applied here too).
 */
export function declaresConfirmedFlag(tool: InterceptableTool): boolean {
  const schema = tool.inputSchema as
    | { properties?: Record<string, unknown> }
    | undefined;
  return Boolean(
    schema &&
      typeof schema === "object" &&
      schema.properties &&
      Object.prototype.hasOwnProperty.call(schema.properties, "confirmed"),
  );
}

export function createToolCallInterceptor(opts?: {
  tokens?: ConfirmationTokenStore;
  denyTier?: RuntimeDenyTier;
}): ToolCallInterceptor {
  const tokens = opts?.tokens ?? createConfirmationTokenStore();
  const denyTier = opts?.denyTier ?? createRuntimeDenyTier();

  return {
    tokens,
    denyTier,
    intercept(tool, args, meta, now = Date.now()) {
      // 1. Deny tier first. A denied tool is refused whether or not it
      //    would also have required confirmation — there is no approval
      //    that makes a blocked action allowed.
      const denied = denyTier.evaluate(tool, args);
      if (denied) return { kind: "denied", reason: denied };

      // 2. Reads run automatically.
      if (!tool.requiresConfirmation) {
        return { kind: "proceed", args, confirmationConsumed: false };
      }

      // 3. Token presented → verify and spend. This is the strong path:
      //    the caller held a 256-bit secret bound to this exact call.
      const presented = meta?.confirmationToken;
      if (typeof presented === "string" && presented.length > 0) {
        const redeemed = tokens.redeem(presented, tool.name, args, now);
        if (!redeemed.ok) {
          return { kind: "confirmation_rejected", reason: redeemed.reason };
        }
        return {
          kind: "proceed",
          args: declaresConfirmedFlag(tool) ? { ...args, confirmed: true } : args,
          confirmationConsumed: true,
        };
      }

      // 4. LEGACY PATH — `confirmed: true` against a LIVE CHALLENGE.
      //
      //    Why this exists: in the chat surface nothing can carry a token
      //    back. `_meta` is set by the orchestrator; the model is what
      //    re-issues the call, and it only knows the tool's own schema.
      //    Requiring the secret there would make all 16 hand-rolled
      //    two-phase tools challenge forever — a production break, and a
      //    violation of "all 37 still complete their two-phase flow".
      //
      //    It is deliberately WEAKER than the token and deliberately
      //    STRONGER than what shipped before: `confirmed: true` alone no
      //    longer authorises anything. The interceptor must have
      //    challenged THIS tool with THESE arguments, within the TTL, and
      //    the challenge is spent on use. So it cannot approve a call that
      //    was never challenged, cannot be moved to a different call, and
      //    cannot be replayed.
      //
      //    Gated on the schema declaring `confirmed`, so it is available
      //    only to tools that already had a working two-phase contract. A
      //    tool with no gate at all (the WARP-320 remote class, and the 8
      //    registry tools that had no check) gets no legacy path and must
      //    present a real token — fail-closed, which is the correct
      //    direction for a write that nothing was guarding.
      if (args.confirmed === true && declaresConfirmedFlag(tool)) {
        const legacy = tokens.redeemLiveChallenge(tool.name, args, now);
        if (legacy.ok) {
          return { kind: "proceed", args, confirmationConsumed: true };
        }
        // No live challenge for this exact call — fall through and issue
        // one. A `confirmed: true` that nothing challenged is not an
        // approval, and must not read as one.
      }

      // 5. Challenge. NO WRITE HAPPENS: the caller returns this outcome
      //    without ever invoking the handler.
      const minted = tokens.mint(tool.name, args, now);
      return {
        kind: "confirmation_required",
        token: minted.token,
        expiresAt: minted.expiresAt,
      };
    },
  };
}

/**
 * The process-wide interceptor.
 *
 * WARP-2340 requires the local agent loop and the MCP server to share ONE
 * implementation so the two cannot drift. They do: both reach
 * `services/mcp-server/src/server.ts`, which uses this instance. Exported
 * so a test can assert the identity rather than trusting a comment.
 */
export const defaultToolCallInterceptor: ToolCallInterceptor =
  createToolCallInterceptor();

/**
 * The audit-facing view of an interceptor decision.
 *
 * WARP-2352: PHI-freedom is a property of this SHAPE, not of a redaction
 * pass. Every field is a scalar the interceptor itself produced — tool
 * name, outcome, reason, expiry. Tool ARGUMENTS are never included and
 * there is no field they could be placed in. `lib/log-redaction.ts`
 * remains the backstop, not the design.
 */
export interface InterceptorAuditEvent {
  outcome: "confirmation_required" | "confirmation_rejected" | "denied" | "confirmed";
  tool: string;
  /** Deny code, or the redeem-failure reason. Absent on success. */
  reason?: string;
  expiresAt?: number;
}

export function interceptorAuditEvent(
  tool: InterceptableTool,
  outcome: InterceptOutcome,
): InterceptorAuditEvent | null {
  switch (outcome.kind) {
    case "confirmation_required":
      return {
        outcome: "confirmation_required",
        tool: tool.name,
        expiresAt: outcome.expiresAt,
      };
    case "confirmation_rejected":
      return {
        outcome: "confirmation_rejected",
        tool: tool.name,
        reason: outcome.reason,
      };
    case "denied":
      return { outcome: "denied", tool: tool.name, reason: outcome.reason.code };
    case "proceed":
      // Only a call that actually SPENT a confirmation is auditable as
      // one. An ordinary read proceeds too and must not write a row.
      return outcome.confirmationConsumed
        ? { outcome: "confirmed", tool: tool.name }
        : null;
  }
}

/**
 * Render a non-proceed outcome as the `ToolResult` the caller returns.
 *
 * `details.interceptor` is the machine-readable block: a consumer reads
 * `details.interceptor.outcome` instead of matching on message prose, and
 * the orchestrator reads it to emit the audit row.
 */
export function interceptOutcomeToToolResult(
  tool: InterceptableTool,
  outcome: InterceptOutcome,
): ToolResult | null {
  if (outcome.kind === "proceed") return null;

  if (outcome.kind === "denied") {
    return {
      ok: false,
      status: "error",
      error: {
        code: "TOOL_DENIED",
        message: outcome.reason.message,
        details: {
          interceptor: {
            outcome: "denied",
            tool: tool.name,
            reason: outcome.reason.code,
          },
        },
      },
    };
  }

  if (outcome.kind === "confirmation_rejected") {
    return {
      ok: false,
      status: "confirmation_required",
      error: {
        code: "CONFIRMATION_REJECTED",
        message:
          `The confirmation presented for '${tool.name}' was refused (${outcome.reason}). ` +
          "Re-issue the call without a token to request a fresh approval from the user.",
        details: {
          interceptor: {
            outcome: "confirmation_rejected",
            tool: tool.name,
            reason: outcome.reason,
          },
        },
      },
    };
  }

  return {
    ok: false,
    status: "confirmation_required",
    error: {
      code: "CONFIRMATION_REQUIRED",
      message:
        `'${tool.name}' writes, so it needs a thumbs-up. Relay this to the user, and ` +
        "only after they explicitly approve, re-issue the SAME call with the SAME arguments " +
        "presenting this confirmationToken. Do NOT approve on the user's behalf.",
      details: {
        interceptor: {
          outcome: "confirmation_required",
          tool: tool.name,
          confirmationToken: outcome.token,
          expiresAt: outcome.expiresAt,
        },
        // WARP-640 — the dashboard chip reads `confirmationToken` at the
        // top level of `details` to render "Approve & run". Kept flat as
        // well as inside `interceptor` so that surface is unchanged.
        confirmationToken: outcome.token,
        type: tool.name,
      },
    },
  };
}
