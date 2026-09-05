/**
 * WARP-2469 — the chat approval round-trip.
 *
 * WHAT WAS MISSING. WARP-2305 made `requiresConfirmation` a real gate:
 * the interceptor refuses a confirming tool and mints a single-use,
 * TTL-bounded token bound to that exact tool + arguments. Nothing turned
 * a user's thumbs-up into that token. `_meta` is set by the
 * orchestrator, but the thing that RE-ISSUES a refused call is the
 * model, and the model has no way to obtain a secret. So every centrally
 * gated tool — the 8 registry tools that had no handler-side check, every
 * connector write tool, every WARP-320 remote tool — failed closed in
 * chat with no path to approval.
 *
 * THE ROUND-TRIP THIS BUILDS:
 *
 *   1. the interceptor challenges           (WARP-2305, unchanged)
 *   2. the agent loop REGISTERS the challenge here and renders it        ← this file
 *   3. the user approves via `POST /api/llm/confirm/:challengeId`        ← routes/llm.ts
 *   4. the agent loop CLAIMS the grant on the model's re-issued call     ← this file
 *      and attaches the token via `_meta`
 *
 * WHY THE TOKEN STAYS HERE. The obvious shortcut is to forward the
 * interceptor's token to the browser in the SSE `tool_result` and let the
 * client echo it back. That would make the approval authenticated by
 * nothing: whoever held the stream would hold the approval, and a `guest`
 * who cannot approve anything would still receive the secret. So the
 * store keeps the token, hands out an opaque `challengeId` that
 * authorises NOTHING on its own, and only a `requireRole`-gated approval
 * turns the challenge into a claimable grant.
 *
 * WHY THE LOOP MAY ATTACH IT. WARP-2305 deliberately never set
 * `McpCallContext.confirmationToken` from the agent loop, on the grounds
 * that "a loop re-attaching a token it was just handed is the model
 * approving its own writes". That reasoning is intact and this does not
 * violate it: the loop can only attach a token that a HUMAN moved from
 * `pending` to `approved` through an authenticated, role-gated route. A
 * token that was merely challenged is never claimable.
 *
 * EXPLICIT ENUM STATE. `status` is a real field with five values, never
 * derived from a null or an absence. Expiry is materialised lazily on
 * read — the same posture as the interceptor's token store, so a
 * challenge is expired whether or not anything sweeps, and nothing here
 * needs a timer (no `while True`, no `cron-runtime` registration).
 *
 * IN-MEMORY, deliberately. The token it guards is itself in-memory in the
 * mcp-server process with a 5-minute TTL, so persisting the challenge
 * would outlive the thing it points at. A restart loses pending
 * approvals, which is correct: the user re-asks and is challenged afresh.
 */
import { randomBytes } from "node:crypto";
import { confirmationBindingHash } from "@droplet/tools-core";
import {
  summarizeToolArguments,
  type ConfirmationSummary,
} from "./confirmation-summary.js";

/**
 * Bound on pending challenges. Oldest-first eviction, mirroring
 * `DEFAULT_MAX_PENDING_CONFIRMATIONS` in the interceptor's own store.
 */
export const DEFAULT_MAX_PENDING_APPROVALS = 500;

/**
 * The five states. Every transition is explicit; none is inferred from
 * the absence of a field.
 *
 *   pending  → approved → spent      (the happy path)
 *   pending  → denied                (the user said no; terminal)
 *   pending  → expired               (TTL passed; terminal)
 *   approved → expired               (approved, never claimed in time)
 */
export type ChatApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "spent";

/**
 * The view that leaves the orchestrator — into the SSE stream, the chat
 * component, and the confirm route's response.
 *
 * There is no `token` field, and there must never be one. The summary is
 * PHI-free by construction (see `confirmation-summary.ts`).
 */
export interface ChatApprovalChallenge {
  challengeId: string;
  tool: string;
  status: ChatApprovalStatus;
  /** Epoch ms, from the interceptor's own mint — not re-derived here. */
  expiresAt: number;
  summary: ConfirmationSummary;
}

export interface RegisterChallengeInput {
  tool: string;
  args: Record<string, unknown>;
  /** The interceptor's minted secret. Never leaves this module. */
  token: string;
  expiresAt: number;
  /** The chat user whose turn was challenged. Only they may approve. */
  userId: string;
}

export type ApprovalFailureReason =
  | "unknown_challenge"
  | "already_resolved"
  | "expired"
  | "not_owner";

export type ApproveResult =
  | { ok: true; token: string; tool: string; expiresAt: number }
  | { ok: false; reason: ApprovalFailureReason };

export type DenyResult =
  | { ok: true; tool: string }
  | { ok: false; reason: ApprovalFailureReason };

export interface ClaimGrantInput {
  tool: string;
  args: Record<string, unknown>;
  userId: string;
}

export interface ChatApprovalStore {
  register(input: RegisterChallengeInput): ChatApprovalChallenge;
  /** Public view, with expiry materialised. `null` for an unknown id. */
  get(challengeId: string, now?: number): ChatApprovalChallenge | null;
  approve(challengeId: string, userId: string, now?: number): ApproveResult;
  deny(challengeId: string, userId: string, now?: number): DenyResult;
  /**
   * The agent-loop side of the round-trip: is there an approved,
   * unexpired, unspent grant for THIS user making THIS exact call? Spends
   * it and returns the token, or returns `null`.
   *
   * Matching is by `confirmationBindingHash` — the interceptor's own
   * function, so the loop's notion of "the same call" cannot drift from
   * the gate's. The interceptor still re-checks the binding when the
   * token is redeemed; this match only ROUTES a grant to a call, it never
   * authorises one.
   */
  claimGrant(input: ClaimGrantInput, now?: number): string | null;
  /** Live entry count. Test/diagnostic surface. */
  size(): number;
}

interface ApprovalEntry {
  challengeId: string;
  tool: string;
  bindingHash: string;
  token: string;
  expiresAt: number;
  userId: string;
  summary: ConfirmationSummary;
  status: ChatApprovalStatus;
}

export interface ChatApprovalStoreOptions {
  maxEntries?: number;
}

export function createChatApprovalStore(
  opts: ChatApprovalStoreOptions = {},
): ChatApprovalStore {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_PENDING_APPROVALS;
  // Insertion-ordered, so Map iteration gives oldest-first eviction with
  // no second index.
  const entries = new Map<string, ApprovalEntry>();

  /**
   * Materialise expiry. A `pending` or `approved` entry past its TTL
   * becomes `expired` — a state the UI renders, rather than a silent
   * nothing. `denied` and `spent` are terminal and are never rewritten:
   * "the user said no" must not decay into "it timed out".
   */
  function settle(entry: ApprovalEntry, now: number): ApprovalEntry {
    if (
      (entry.status === "pending" || entry.status === "approved") &&
      entry.expiresAt <= now
    ) {
      entry.status = "expired";
    }
    return entry;
  }

  function publicView(entry: ApprovalEntry): ChatApprovalChallenge {
    return {
      challengeId: entry.challengeId,
      tool: entry.tool,
      status: entry.status,
      expiresAt: entry.expiresAt,
      summary: entry.summary,
    };
  }

  /** Shared precondition for approve and deny. */
  function resolvable(
    challengeId: string,
    userId: string,
    now: number,
  ): { ok: true; entry: ApprovalEntry } | { ok: false; reason: ApprovalFailureReason } {
    const entry = entries.get(challengeId);
    if (!entry) return { ok: false, reason: "unknown_challenge" };
    // Ownership BEFORE expiry: another user must learn nothing about a
    // challenge that is not theirs, not even whether it is still live.
    if (entry.userId !== userId) return { ok: false, reason: "not_owner" };
    settle(entry, now);
    if (entry.status === "expired") return { ok: false, reason: "expired" };
    if (entry.status !== "pending") return { ok: false, reason: "already_resolved" };
    return { ok: true, entry };
  }

  return {
    register(input) {
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      // 128 bits of CSPRNG output. Unguessable — but note that guessing
      // one would still not approve anything: the confirm route checks
      // ownership against the authenticated session.
      const challengeId = randomBytes(16).toString("base64url");
      const entry: ApprovalEntry = {
        challengeId,
        tool: input.tool,
        bindingHash: confirmationBindingHash(input.tool, input.args),
        token: input.token,
        expiresAt: input.expiresAt,
        userId: input.userId,
        summary: summarizeToolArguments(input.tool, input.args),
        status: "pending",
      };
      entries.set(challengeId, entry);
      return publicView(entry);
    },

    get(challengeId, now = Date.now()) {
      const entry = entries.get(challengeId);
      if (!entry) return null;
      return publicView(settle(entry, now));
    },

    approve(challengeId, userId, now = Date.now()) {
      const pre = resolvable(challengeId, userId, now);
      if (!pre.ok) return pre;
      pre.entry.status = "approved";
      return {
        ok: true,
        token: pre.entry.token,
        tool: pre.entry.tool,
        expiresAt: pre.entry.expiresAt,
      };
    },

    deny(challengeId, userId, now = Date.now()) {
      const pre = resolvable(challengeId, userId, now);
      if (!pre.ok) return pre;
      // Terminal, and the token becomes unreachable: nothing reads
      // `entry.token` in any state other than `approved`.
      pre.entry.status = "denied";
      return { ok: true, tool: pre.entry.tool };
    },

    claimGrant(input, now = Date.now()) {
      const wanted = confirmationBindingHash(input.tool, input.args);
      for (const entry of entries.values()) {
        if (entry.userId !== input.userId) continue;
        if (entry.bindingHash !== wanted) continue;
        settle(entry, now);
        if (entry.status !== "approved") continue;
        entry.status = "spent";
        return entry.token;
      }
      return null;
    },

    size() {
      return entries.size;
    },
  };
}

/**
 * The process-wide store.
 *
 * One instance, because the two halves of the round-trip live in
 * different modules: `routes/llm.ts` approves, `llm-agent.service.ts`
 * claims. A second instance would silently break the round-trip — the
 * approval would land somewhere the loop never looks — which is the
 * failure `confirm-dispatcher-coverage.guard.test.ts` exists because of.
 */
export const chatApprovalStore: ChatApprovalStore = createChatApprovalStore();
