/**
 * WARP-2318 — the confirmation token contract.
 *
 * An unbound confirmation is worse than none, because it looks like a
 * control while authorising anything. Each of the four refusals the
 * ticket names gets its own test, plus `unknown_token`, because if any
 * one of them silently succeeded the interceptor would be a formality.
 *
 * Mutations these are written to catch:
 *   - drop the tool name from the binding  → "wrong tool" goes red
 *   - drop the arguments from the binding  → "mutated arguments" goes red
 *   - remove the TTL check                 → "expired" goes red
 *   - make the token stateless             → "already spent" goes red
 *   - sort arrays in canonicalization      → "array order" goes red
 *   - stop excluding `confirmed`           → "legacy confirmed flag" red
 */
import { describe, it, expect } from "vitest";
import {
  canonicalizeToolArgs,
  confirmationBindingHash,
  createConfirmationTokenStore,
  DEFAULT_CONFIRMATION_TTL_MS,
} from "../src/confirmation-token.js";

const T0 = 1_700_000_000_000;

describe("confirmation token — binding (WARP-2318)", () => {
  it("mints an opaque token bound to tool + args, redeemable once", () => {
    const store = createConfirmationTokenStore();
    const { token, expiresAt } = store.mint("delete_file", { path: "/a" }, T0);

    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(expiresAt).toBe(T0 + DEFAULT_CONFIRMATION_TTL_MS);

    const redeemed = store.redeem(token, "delete_file", { path: "/a" }, T0 + 1000);
    expect(redeemed).toEqual({ ok: true, mintedAt: T0 });
  });

  it("refuses a token replayed against a DIFFERENT TOOL", () => {
    const store = createConfirmationTokenStore();
    const { token } = store.mint("delete_file", { path: "/a" }, T0);

    // Mutation: drop the tool name from the binding hash → this passes.
    expect(store.redeem(token, "write_file", { path: "/a" }, T0 + 1)).toEqual({
      ok: false,
      reason: "wrong_tool",
    });
  });

  it("refuses a token replayed against MUTATED ARGUMENTS", () => {
    const store = createConfirmationTokenStore();
    const { token } = store.mint("delete_file", { path: "/tmp/scratch" }, T0);

    // The whole point: a thumbs-up for one write must not authorise
    // another. Mutation: bind to tool name only → this passes.
    expect(
      store.redeem(token, "delete_file", { path: "/payroll/2026.xlsx" }, T0 + 1),
    ).toEqual({ ok: false, reason: "arguments_mismatch" });
  });

  it("refuses a token PAST ITS TTL", () => {
    const store = createConfirmationTokenStore();
    const { token } = store.mint("delete_file", { path: "/a" }, T0);

    // Mutation: remove the TTL check → this passes.
    expect(
      store.redeem(token, "delete_file", { path: "/a" }, T0 + DEFAULT_CONFIRMATION_TTL_MS + 1),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses the SECOND use of a spent token", () => {
    const store = createConfirmationTokenStore();
    const { token } = store.mint("delete_file", { path: "/a" }, T0);

    expect(store.redeem(token, "delete_file", { path: "/a" }, T0 + 1).ok).toBe(true);
    // Mutation: make the token stateless (verify a signature instead of
    // spending an entry) → this passes.
    expect(store.redeem(token, "delete_file", { path: "/a" }, T0 + 2)).toEqual({
      ok: false,
      reason: "already_used",
    });
  });

  it("refuses a token that was never minted", () => {
    const store = createConfirmationTokenStore();
    expect(store.redeem("not-a-real-token", "delete_file", {}, T0)).toEqual({
      ok: false,
      reason: "unknown_token",
    });
  });

  it("does NOT spend the token on a failed redeem, so a corrected retry still works", () => {
    const store = createConfirmationTokenStore();
    const { token } = store.mint("delete_file", { path: "/a" }, T0);

    expect(store.redeem(token, "delete_file", { path: "/WRONG" }, T0 + 1).ok).toBe(false);
    // The user already approved this. Burning the token on a mistyped
    // retry would lock them out of their own approval.
    expect(store.redeem(token, "delete_file", { path: "/a" }, T0 + 2).ok).toBe(true);
  });
});

describe("confirmation token — argument canonicalization (WARP-2318)", () => {
  it("is STABLE under key ordering", () => {
    const store = createConfirmationTokenStore();
    const { token } = store.mint("share_file", { path: "/a", expires: 7, note: "x" }, T0);

    // Same values, different key order — still the same confirmation.
    expect(
      store.redeem(token, "share_file", { note: "x", path: "/a", expires: 7 }, T0 + 1).ok,
    ).toBe(true);
  });

  it("is stable under key ordering at NESTED levels too", () => {
    expect(canonicalizeToolArgs({ a: { x: 1, y: 2 } })).toBe(
      canonicalizeToolArgs({ a: { y: 2, x: 1 } }),
    );
  });

  it("is SENSITIVE to a single changed value", () => {
    expect(confirmationBindingHash("t", { n: 1 })).not.toBe(
      confirmationBindingHash("t", { n: 2 }),
    );
  });

  it("is sensitive to an added or removed key", () => {
    const base = confirmationBindingHash("t", { a: 1 });
    expect(confirmationBindingHash("t", { a: 1, b: 2 })).not.toBe(base);
    expect(confirmationBindingHash("t", {})).not.toBe(base);
  });

  it("preserves ARRAY ORDER — order is semantic, so a reorder is a different call", () => {
    // A scene's ordered command list, a recipient list. Mutation: sort
    // arrays in canonicalization → this passes, and a reordered array
    // could replay another call's token.
    expect(confirmationBindingHash("run_scene", { steps: ["unlock", "open"] })).not.toBe(
      confirmationBindingHash("run_scene", { steps: ["open", "unlock"] }),
    );
  });

  it("cannot be forged by a string that mimics the serializer's delimiters", () => {
    expect(confirmationBindingHash("t", { a: '1,"b":2' })).not.toBe(
      confirmationBindingHash("t", { a: "1", b: 2 }),
    );
  });

  it("cannot collide across a tool-name/arg boundary shift", () => {
    // Length-prefixing the tool name is what stops this.
    expect(confirmationBindingHash("ab", { c: 1 })).not.toBe(
      confirmationBindingHash("a", { bc: 1 }),
    );
  });

  it("EXCLUDES the legacy `confirmed` control flag from the binding", () => {
    // Load-bearing for the 37 legacy tools: their descriptions tell the
    // model to re-issue with `confirmed: true`. If that key were hashed,
    // every legacy two-phase flow would fail as arguments_mismatch.
    // Mutation: stop excluding it → this goes red.
    const store = createConfirmationTokenStore();
    const { token } = store.mint("memory_forget", { id: "f1" }, T0);
    expect(
      store.redeem(token, "memory_forget", { id: "f1", confirmed: true }, T0 + 1).ok,
    ).toBe(true);
  });

  it("does not let `confirmed` mask a real argument change", () => {
    const store = createConfirmationTokenStore();
    const { token } = store.mint("memory_forget", { id: "f1" }, T0);
    expect(
      store.redeem(token, "memory_forget", { id: "f2", confirmed: true }, T0 + 1),
    ).toEqual({ ok: false, reason: "arguments_mismatch" });
  });
});

describe("confirmation token — store hygiene (WARP-2318)", () => {
  it("sweeps expired entries without any scheduling primitive", () => {
    const store = createConfirmationTokenStore();
    store.mint("a", {}, T0);
    store.mint("b", {}, T0);
    expect(store.size()).toBe(2);

    expect(store.sweepExpired(T0 + DEFAULT_CONFIRMATION_TTL_MS + 1)).toBe(2);
    expect(store.size()).toBe(0);
  });

  it("expiry is LAZY — a token past TTL is refused even if nothing ever sweeps", () => {
    // This is why the contract needs no cron job and contains no
    // `while True`: correctness never depends on a timer firing.
    const store = createConfirmationTokenStore();
    const { token } = store.mint("a", {}, T0);
    expect(store.redeem(token, "a", {}, T0 + DEFAULT_CONFIRMATION_TTL_MS + 1)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("is bounded, so a caller that mints and never redeems cannot grow it forever", () => {
    const store = createConfirmationTokenStore({ maxEntries: 3 });
    const first = store.mint("a", { i: 0 }, T0);
    for (let i = 1; i < 10; i++) store.mint("a", { i }, T0);

    expect(store.size()).toBeLessThanOrEqual(3);
    // Oldest-first eviction — the first token is gone, not a recent one.
    expect(store.redeem(first.token, "a", { i: 0 }, T0 + 1)).toEqual({
      ok: false,
      reason: "unknown_token",
    });
  });

  it("mints unique tokens", () => {
    const store = createConfirmationTokenStore();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(store.mint("a", { i }, T0).token);
    expect(seen.size).toBe(200);
  });
});
