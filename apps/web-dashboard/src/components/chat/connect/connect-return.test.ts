/**
 * WARP-3904 — the OAuth round trip of a connect card: the sessionStorage record
 * the card writes before leaving, and what the chat page does when the box's
 * callback redirects back to `/chat?google=<outcome>` / `/chat?m365=<outcome>`.
 *
 * The property that matters most: a crafted link can never cause a turn on its
 * own. A turn exists only when THIS tab wrote a matching, fresh record first.
 */
import { describe, it, expect } from "vitest";
import {
  CONNECT_RETURN_KEY,
  CONNECT_RETURN_MAX_AGE_MS,
  CONNECT_RETURN_PROVIDERS,
  CONNECT_RETURN_SUCCESS,
  clearConnectReturn,
  connectReturnFailureMessage,
  safeSessionStorage,
  saveConnectReturn,
  takeConnectReturn,
  type ConnectReturnRecord,
} from "./connect-return";

const NOW = 1_800_000_000_000;

function memoryStorage(initial?: Record<string, string>) {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

function record(over: Partial<ConnectReturnRecord> = {}): ConnectReturnRecord {
  return { conversationId: "conv-1", provider: "google", displayName: "Google", at: NOW - 30_000, ...over };
}

function stored(over: Partial<ConnectReturnRecord> = {}) {
  return memoryStorage({ [CONNECT_RETURN_KEY]: JSON.stringify(record(over)) });
}

describe("takeConnectReturn — success", () => {
  it("returns connected with the stored conversation and the success turn for a fresh, matching record", () => {
    const storage = stored();
    const result = takeConnectReturn({ provider: "google", outcome: CONNECT_RETURN_SUCCESS, storage, now: NOW });
    expect(result).toEqual({
      kind: "connected",
      conversationId: "conv-1",
      displayName: "Google",
      turn: "Google is connected now.",
    });
  });

  it("works the same for Microsoft 365", () => {
    const storage = stored({ provider: "m365", displayName: "Microsoft 365", conversationId: "conv-9" });
    const result = takeConnectReturn({ provider: "m365", outcome: "connected", storage, now: NOW });
    expect(result).toMatchObject({ kind: "connected", conversationId: "conv-9", turn: "Microsoft 365 is connected now." });
  });

  it("clears the record after reading it, so a refresh or back-navigation cannot replay the turn", () => {
    const storage = stored();
    expect(takeConnectReturn({ provider: "google", outcome: "connected", storage, now: NOW }).kind).toBe("connected");
    expect(storage.map.has(CONNECT_RETURN_KEY)).toBe(false);
    expect(takeConnectReturn({ provider: "google", outcome: "connected", storage, now: NOW })).toEqual({ kind: "none" });
  });

  it("keeps a missing, empty or oversized conversation id as null instead of guessing", () => {
    for (const conversationId of [null, "", "x".repeat(129)]) {
      const storage = stored({ conversationId: conversationId as string | null });
      const result = takeConnectReturn({ provider: "google", outcome: "connected", storage, now: NOW });
      expect(result).toMatchObject({ kind: "connected", conversationId: null });
    }
  });

  it("flattens control characters and caps a display name that ends up inside a user turn", () => {
    const messy = takeConnectReturn({
      provider: "google",
      outcome: "connected",
      storage: stored({ displayName: "Goo\ngle\u0000  Mail" }),
      now: NOW,
    });
    expect(messy).toMatchObject({ kind: "connected", displayName: "Goo gle Mail", turn: "Goo gle Mail is connected now." });

    const long = takeConnectReturn({
      provider: "google",
      outcome: "connected",
      storage: stored({ displayName: "A".repeat(500) }),
      now: NOW,
    });
    expect(long.kind === "connected" && long.displayName.length).toBe(120);
  });

  it("falls back to the provider's own name when the record carries none", () => {
    const result = takeConnectReturn({ provider: "m365", outcome: "connected", storage: stored({ provider: "m365", displayName: "" }), now: NOW });
    expect(result).toMatchObject({ kind: "connected", displayName: "Microsoft 365" });
  });
});

describe("takeConnectReturn — nothing to do", () => {
  it("is none for a success outcome when no record was written (a hand-typed or other-browser link)", () => {
    expect(takeConnectReturn({ provider: "google", outcome: "connected", storage: memoryStorage(), now: NOW })).toEqual({ kind: "none" });
  });

  it("is none when the record belongs to the other provider", () => {
    const storage = stored({ provider: "m365" });
    expect(takeConnectReturn({ provider: "google", outcome: "connected", storage, now: NOW })).toEqual({ kind: "none" });
  });

  it("is none when the record is older than the TTL, and exactly at the TTL is still good", () => {
    const stale = stored({ at: NOW - CONNECT_RETURN_MAX_AGE_MS - 1 });
    expect(takeConnectReturn({ provider: "google", outcome: "connected", storage: stale, now: NOW })).toEqual({ kind: "none" });

    const edge = stored({ at: NOW - CONNECT_RETURN_MAX_AGE_MS });
    expect(takeConnectReturn({ provider: "google", outcome: "connected", storage: edge, now: NOW }).kind).toBe("connected");
  });

  it("is none for a timestamp from the future", () => {
    const storage = stored({ at: NOW + 10 * 60_000 });
    expect(takeConnectReturn({ provider: "google", outcome: "connected", storage, now: NOW })).toEqual({ kind: "none" });
  });

  it("is none for malformed or partial records, and never throws", () => {
    const bad = [
      "not json",
      "null",
      "42",
      JSON.stringify({ provider: "google" }),
      JSON.stringify({ provider: "google", at: "yesterday" }),
      JSON.stringify({ at: NOW }),
    ];
    for (const raw of bad) {
      const storage = memoryStorage({ [CONNECT_RETURN_KEY]: raw });
      expect(takeConnectReturn({ provider: "google", outcome: "connected", storage, now: NOW })).toEqual({ kind: "none" });
      expect(storage.map.has(CONNECT_RETURN_KEY)).toBe(false);
    }
  });

  it("is none when storage is blocked or absent", () => {
    expect(takeConnectReturn({ provider: "google", outcome: "connected", storage: null, now: NOW })).toEqual({ kind: "none" });
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(takeConnectReturn({ provider: "google", outcome: "connected", storage: throwing, now: NOW })).toEqual({ kind: "none" });
  });
});

describe("takeConnectReturn — failure", () => {
  it.each(["access_denied", "expired", "error", "state_mismatch", ""])("returns failed with a message and NO turn for outcome %j", (outcome) => {
    const storage = stored();
    const result = takeConnectReturn({ provider: "google", outcome, storage, now: NOW });
    expect(result).toEqual({
      kind: "failed",
      conversationId: "conv-1",
      displayName: "Google",
      message: "Connecting Google didn't finish. You can try again from Settings.",
    });
    expect(result).not.toHaveProperty("turn");
    expect(storage.map.has(CONNECT_RETURN_KEY)).toBe(false);
  });

  it("still reports a failure when there is no record, but with no conversation to return to", () => {
    const result = takeConnectReturn({ provider: "m365", outcome: "access_denied", storage: memoryStorage(), now: NOW });
    expect(result).toEqual({
      kind: "failed",
      conversationId: null,
      displayName: "Microsoft 365",
      message: connectReturnFailureMessage("Microsoft 365"),
    });
  });

  it("does not borrow another provider's conversation or name for a failure", () => {
    const result = takeConnectReturn({ provider: "google", outcome: "error", storage: stored({ provider: "m365", displayName: "Microsoft 365" }), now: NOW });
    expect(result).toMatchObject({ kind: "failed", conversationId: null, displayName: "Google" });
  });

  it("uses sentence-case copy with no exclamation mark", () => {
    const message = connectReturnFailureMessage("Google");
    expect(message).not.toContain("!");
    expect(message).toMatch(/^Connecting Google/);
  });
});

describe("the record", () => {
  it("is written as exactly four fields: nothing secret, no token, no URL", () => {
    const storage = memoryStorage();
    expect(saveConnectReturn(storage, record())).toBe(true);
    const written = JSON.parse(storage.map.get(CONNECT_RETURN_KEY) as string) as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(["at", "conversationId", "displayName", "provider"]);
  });

  it("reports false instead of throwing when storage is blocked", () => {
    expect(saveConnectReturn(null, record())).toBe(false);
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
    };
    expect(saveConnectReturn(full, record())).toBe(false);
  });

  it("clearConnectReturn removes it and tolerates blocked storage", () => {
    const storage = stored();
    clearConnectReturn(storage);
    expect(storage.map.has(CONNECT_RETURN_KEY)).toBe(false);
    expect(() => clearConnectReturn(null)).not.toThrow();
  });

  it("round-trips through the real sessionStorage", () => {
    const real = safeSessionStorage();
    expect(real).not.toBeNull();
    saveConnectReturn(real, record({ at: Date.now() }));
    const result = takeConnectReturn({ provider: "google", outcome: "connected", storage: real, now: Date.now() });
    expect(result).toMatchObject({ kind: "connected", conversationId: "conv-1" });
    expect(real?.getItem(CONNECT_RETURN_KEY)).toBeNull();
  });

  it("names exactly the two OAuth families", () => {
    expect([...CONNECT_RETURN_PROVIDERS]).toEqual(["google", "m365"]);
  });
});
