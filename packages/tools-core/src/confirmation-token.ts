/**
 * WARP-2318 — the confirmation token: single-use, TTL-bounded, and bound
 * to tool name PLUS arguments.
 *
 * WHY A TOKEN AND NOT A BOOLEAN. Before WARP-2305 a "confirmation" was
 * `confirmed: true` — an argument the model sets on itself. The model is
 * steered by user-controlled prompt text (the ADR-004 threat model quoted
 * in `tool-access.service.ts`), so that boolean could be produced without
 * a human ever seeing a prompt. An unbound confirmation is worse than
 * none, because it looks like a control while authorising anything: a
 * thumbs-up for `delete_file("/tmp/x")` must not authorise
 * `delete_file("/payroll")`.
 *
 * The full contract is `docs/tool-confirmation-contract.md`.
 */
import { createHash, randomBytes } from "node:crypto";

/** Five minutes. Long enough for a human to read a prompt and answer,
 *  short enough that an abandoned approval cannot be picked up later. */
export const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60_000;

/** Bound on the in-memory store, so a caller that mints and never
 *  redeems cannot grow it without limit. Oldest-first eviction. */
export const DEFAULT_MAX_PENDING_CONFIRMATIONS = 1_000;

/**
 * Argument keys excluded from the binding hash.
 *
 * `confirmed` is a CONTROL FLAG, never payload — it carries no write
 * semantics of its own now that the interceptor owns that decision.
 * Excluding it is load-bearing for backwards compatibility: 16 of the 37
 * legacy confirming tools tell the model, in their description, to
 * re-issue the call with `confirmed: true`. If that key were hashed, the
 * confirming call's arguments would differ from the challenged call's and
 * EVERY legacy two-phase flow would fail as `arguments_mismatch`.
 */
export const CONFIRMATION_CONTROL_KEYS: readonly string[] = ["confirmed"];

/**
 * Deterministic serialization of tool arguments for the binding hash.
 *
 * Stable under key ordering (object keys sorted recursively) but
 * sensitive to values — WARP-2318 requires exactly that pair: a
 * reordered-keys payload with identical values still confirms, a single
 * changed value does not.
 *
 * Arrays are NOT sorted: element order is semantic in every tool schema
 * that takes one (a scene's ordered command list, a recipient list), so
 * sorting them would let a reordered array replay another's token.
 */
export function canonicalizeToolArgs(args: Record<string, unknown>): string {
  return stableStringify(stripControlKeys(args));
}

function stripControlKeys(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (CONFIRMATION_CONTROL_KEYS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      // `undefined` is not representable in JSON and reaches us only from
      // a hand-built args object; dropping it keeps `{a:1}` and
      // `{a:1,b:undefined}` from hashing differently on one path and the
      // same on the other (JSON.stringify drops it too).
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  // string | number | boolean — JSON.stringify gives the canonical form
  // and escapes strings so `{"a:1}` cannot forge a delimiter.
  return JSON.stringify(value) ?? "null";
}

/** SHA-256 over `tool name + canonical args`. The tool name is length-
 *  prefixed so `("ab", {c:1})` and `("a", {b:1})` cannot collide. */
export function confirmationBindingHash(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const canonical = canonicalizeToolArgs(args);
  return createHash("sha256")
    .update(`${toolName.length}:${toolName}:${canonical}`, "utf8")
    .digest("hex");
}

/**
 * The five distinguishable refusals. WARP-2318 requires each to be
 * separately testable — if any one of them silently succeeded, the
 * interceptor would be a formality.
 */
export type ConfirmationRedeemFailure =
  | "unknown_token"
  | "already_used"
  | "expired"
  | "wrong_tool"
  | "arguments_mismatch";

export type ConfirmationRedeemResult =
  | { ok: true; mintedAt: number }
  | { ok: false; reason: ConfirmationRedeemFailure };

export interface MintedConfirmation {
  token: string;
  expiresAt: number;
}

export interface ConfirmationTokenStore {
  /** Mint a token bound to this exact tool + arguments. */
  mint(toolName: string, args: Record<string, unknown>, now?: number): MintedConfirmation;
  /** Verify and SPEND a token. A failed redeem does not spend it. */
  redeem(
    token: string,
    toolName: string,
    args: Record<string, unknown>,
    now?: number,
  ): ConfirmationRedeemResult;
  /**
   * Spend a live challenge for this exact tool + arguments WITHOUT
   * presenting the token secret — the legacy `confirmed: true` path.
   *
   * Exists because the chat surface has no way to carry a token back:
   * `_meta` is set by the orchestrator, not by the model, and the model
   * is what re-issues a confirming call. Requiring the secret there would
   * make every one of the 16 hand-rolled two-phase tools challenge
   * forever. See `docs/tool-confirmation-contract.md` §5.
   *
   * WEAKER THAN `redeem`, deliberately and explicitly: it proves the call
   * was challenged, not that the approver held a secret. It still binds
   * to tool + arguments, still expires, and is still single-use — so a
   * `confirmed: true` cannot authorise a call that was never challenged,
   * cannot authorise a DIFFERENT call, and cannot be replayed.
   */
  redeemLiveChallenge(
    toolName: string,
    args: Record<string, unknown>,
    now?: number,
  ): ConfirmationRedeemResult;
  /** Drop expired entries. Pure memory hygiene — see the note below. */
  sweepExpired(now?: number): number;
  /** Pending (minted, unspent) entries. Test/diagnostic surface. */
  size(): number;
}

export interface ConfirmationTokenStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
}

interface PendingConfirmation {
  toolName: string;
  bindingHash: string;
  mintedAt: number;
  expiresAt: number;
  usedAt: number | null;
}

/**
 * In-process store, held by the dispatching mcp-server.
 *
 * EXPIRY IS LAZY, BY DESIGN. `redeem` checks the TTL on every call, so an
 * expired token is refused whether or not anything ever sweeps.
 * `sweepExpired` is therefore memory hygiene, not correctness, and is
 * called opportunistically from `mint` — which means this contract needs
 * NO scheduled sweep at all, and so contains no `while True`, no
 * `apscheduler` job and no `cron-runtime.service.ts` registration
 * (WARP-2318). Correctness never depends on a timer firing.
 */
export function createConfirmationTokenStore(
  opts: ConfirmationTokenStoreOptions = {},
): ConfirmationTokenStore {
  const ttlMs = opts.ttlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_PENDING_CONFIRMATIONS;
  // Insertion-ordered: Map iteration order gives oldest-first eviction
  // without a second index.
  const pending = new Map<string, PendingConfirmation>();

  function sweep(now: number): number {
    let dropped = 0;
    for (const [token, entry] of pending) {
      if (entry.expiresAt <= now) {
        pending.delete(token);
        dropped++;
      }
    }
    return dropped;
  }

  return {
    mint(toolName, args, now = Date.now()) {
      sweep(now);
      while (pending.size >= maxEntries) {
        const oldest = pending.keys().next();
        if (oldest.done) break;
        pending.delete(oldest.value);
      }
      // 256 bits of CSPRNG output. Unguessable, so the Map lookup below
      // needs no constant-time compare: there is nothing to brute-force
      // within a 5-minute TTL.
      const token = randomBytes(32).toString("base64url");
      const expiresAt = now + ttlMs;
      pending.set(token, {
        toolName,
        bindingHash: confirmationBindingHash(toolName, args),
        mintedAt: now,
        expiresAt,
        usedAt: null,
      });
      return { token, expiresAt };
    },

    redeem(token, toolName, args, now = Date.now()) {
      const entry = pending.get(token);
      if (!entry) return { ok: false, reason: "unknown_token" };

      // Order matters: each branch is the most specific true statement we
      // can make, so a test can isolate exactly one reason.
      if (entry.usedAt !== null) return { ok: false, reason: "already_used" };
      if (entry.expiresAt <= now) return { ok: false, reason: "expired" };

      // THE HASH IS THE SOLE AUTHORISATION. Both halves of the binding —
      // tool name and arguments — live in it, and this one comparison is
      // what admits the call. The stored `toolName` below only CLASSIFIES
      // a failure into a more useful reason; it never authorises.
      //
      // Deliberate: an earlier revision compared `entry.toolName` as a
      // separate gate, which made the tool-name component of the hash
      // redundant — dropping it from `confirmationBindingHash` then
      // changed nothing observable and the wrong-tool test stayed green
      // under that mutation. One binding, one comparison.
      if (entry.bindingHash !== confirmationBindingHash(toolName, args)) {
        return {
          ok: false,
          reason: entry.toolName !== toolName ? "wrong_tool" : "arguments_mismatch",
        };
      }

      // Spend ONLY on success. A mismatched attempt must not burn the
      // token, or a caller who retries with corrected arguments would be
      // locked out of an approval the user already gave.
      entry.usedAt = now;
      return { ok: true, mintedAt: entry.mintedAt };
    },

    redeemLiveChallenge(toolName, args, now = Date.now()) {
      const wanted = confirmationBindingHash(toolName, args);
      let sawSpent = false;
      let sawExpired = false;
      for (const entry of pending.values()) {
        if (entry.bindingHash !== wanted) continue;
        if (entry.usedAt !== null) {
          sawSpent = true;
          continue;
        }
        if (entry.expiresAt <= now) {
          sawExpired = true;
          continue;
        }
        entry.usedAt = now;
        return { ok: true, mintedAt: entry.mintedAt };
      }
      // Most specific true statement available, same as `redeem`.
      if (sawSpent) return { ok: false, reason: "already_used" };
      if (sawExpired) return { ok: false, reason: "expired" };
      return { ok: false, reason: "unknown_token" };
    },

    sweepExpired(now = Date.now()) {
      return sweep(now);
    },

    size() {
      return pending.size;
    },
  };
}
