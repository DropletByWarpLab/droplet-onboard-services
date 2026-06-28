import { describe, it, expect, vi, beforeEach } from "vitest";

// Set JWT_SECRET before imports (mirrors jwt.test.ts).
process.env.JWT_SECRET = "test-jwt-secret-for-unit-tests-only-not-production";

// ── Cache mock — backed by an in-memory store that understands both the
//    scalar key/value ops (cacheGet/cacheSet/cacheDel) AND the Redis-set
//    ops (cacheSetAdd/cacheSetRemove/cacheSetMembers) that the session
//    index relies on. A Set per key models SADD/SREM/SMEMBERS; a Map per
//    key models the scalar denylist entries. ──
const scalarStore = new Map<string, unknown>();
const setStore = new Map<string, Set<string>>();
// Captures the TTL (3rd arg) passed to cacheSet per key, so a test can assert
// the denylist entry got the token's REMAINING lifetime, not a fixed constant.
const scalarTtlStore = new Map<string, number | undefined>();

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn(async (key: string) => scalarStore.get(key) ?? null),
  cacheSet: vi.fn(async (key: string, value: unknown, ttlSeconds?: number) => {
    scalarStore.set(key, value);
    scalarTtlStore.set(key, ttlSeconds);
  }),
  cacheDel: vi.fn(async (key: string) => {
    scalarStore.delete(key);
    setStore.delete(key);
    scalarTtlStore.delete(key);
  }),
  cacheSetNx: vi.fn(async (key: string, value: unknown) => {
    if (scalarStore.has(key)) return false;
    scalarStore.set(key, value);
    return true;
  }),
  cacheSetAdd: vi.fn(async (key: string, member: string, _ttl?: number) => {
    let s = setStore.get(key);
    if (!s) {
      s = new Set<string>();
      setStore.set(key, s);
    }
    s.add(member);
  }),
  cacheSetRemove: vi.fn(async (key: string, member: string) => {
    setStore.get(key)?.delete(member);
  }),
  cacheSetMembers: vi.fn(async (key: string) => {
    return Array.from(setStore.get(key) ?? []);
  }),
}));

import {
  signRefreshToken,
  verifyRefreshToken,
  registerRefreshSession,
  unregisterRefreshSession,
  revokeUserSessions,
  REFRESH_TOKEN_TTL_SECONDS,
} from "../services/jwt.service.js";

const SESSION_SET_PREFIX = "jwt:sessions:";

function makeRefresh(id: string, username = "alice") {
  return signRefreshToken({ id, username, displayName: "Alice", role: "family" });
}

describe("session revocation (WARP-116)", () => {
  beforeEach(() => {
    scalarStore.clear();
    setStore.clear();
    scalarTtlStore.clear();
    vi.clearAllMocks();
  });

  describe("registerRefreshSession", () => {
    it("adds a member to the user's session set on login/refresh", async () => {
      const token = makeRefresh("user-1");
      await registerRefreshSession("user-1", token);

      const members = setStore.get(SESSION_SET_PREFIX + "user-1");
      expect(members).toBeDefined();
      expect(members!.size).toBe(1);
    });

    it("tracks multiple concurrent device sessions for the same user", async () => {
      await registerRefreshSession("user-1", makeRefresh("user-1"));
      await registerRefreshSession("user-1", makeRefresh("user-1"));

      const members = setStore.get(SESSION_SET_PREFIX + "user-1");
      // Two distinct tokens → two members (the exp-suffixed hash differs by
      // token, so the same user keeps a member per live device).
      expect(members!.size).toBe(2);
    });

    it("does not register a forged/unsigned token", async () => {
      await registerRefreshSession("user-1", "forged.header.sig");
      expect(setStore.get(SESSION_SET_PREFIX + "user-1")).toBeUndefined();
    });
  });

  describe("unregisterRefreshSession", () => {
    it("removes the token's member from the set on logout", async () => {
      const token = makeRefresh("user-1");
      await registerRefreshSession("user-1", token);
      expect(setStore.get(SESSION_SET_PREFIX + "user-1")!.size).toBe(1);

      await unregisterRefreshSession("user-1", token);
      expect(setStore.get(SESSION_SET_PREFIX + "user-1")!.size).toBe(0);
    });

    it("leaves other device sessions intact", async () => {
      const keep = makeRefresh("user-1");
      const drop = makeRefresh("user-1");
      await registerRefreshSession("user-1", keep);
      await registerRefreshSession("user-1", drop);

      await unregisterRefreshSession("user-1", drop);

      // The kept token must still verify; the dropped one is just unindexed
      // (logout denylists it separately).
      expect(await verifyRefreshToken(keep)).not.toBeNull();
      expect(setStore.get(SESSION_SET_PREFIX + "user-1")!.size).toBe(1);
    });
  });

  describe("revokeUserSessions", () => {
    it("denylists every registered refresh token and rejects them immediately", async () => {
      const t1 = makeRefresh("user-1");
      const t2 = makeRefresh("user-1");
      await registerRefreshSession("user-1", t1);
      await registerRefreshSession("user-1", t2);

      // Both valid before revoke.
      expect(await verifyRefreshToken(t1)).not.toBeNull();
      expect(await verifyRefreshToken(t2)).not.toBeNull();

      const count = await revokeUserSessions("user-1");
      expect(count).toBe(2);

      // Both rejected immediately after revoke.
      expect(await verifyRefreshToken(t1)).toBeNull();
      expect(await verifyRefreshToken(t2)).toBeNull();
    });

    it("clears the session set after revoking", async () => {
      await registerRefreshSession("user-1", makeRefresh("user-1"));
      await revokeUserSessions("user-1");
      // Set key cleared so a stale index can't be re-revoked or leak hashes.
      expect(setStore.get(SESSION_SET_PREFIX + "user-1")).toBeUndefined();
    });

    it("returns 0 and is a no-op for a user with no sessions", async () => {
      const count = await revokeUserSessions("ghost");
      expect(count).toBe(0);
    });

    it("denylists with the token's remaining TTL, not a fixed value", async () => {
      const token = makeRefresh("user-1");
      await registerRefreshSession("user-1", token);
      await revokeUserSessions("user-1");

      // Exactly one denylist entry, keyed under jwt:deny:.
      const denyKeys = Array.from(scalarStore.keys()).filter((k) =>
        k.startsWith("jwt:deny:"),
      );
      expect(denyKeys).toHaveLength(1);

      // The captured TTL must be the token's REMAINING lifetime (exp - now ≈
      // the full 7-day TTL for a freshly-minted token), NOT a fixed constant.
      // A regression to e.g. `cacheSet(key, true, 3600)` would fail this.
      const ttl = scalarTtlStore.get(denyKeys[0]);
      expect(ttl).toBeDefined();
      // The TTL tracks exp - now (≈ the full refresh TTL for a fresh token),
      // bounded above by it, with a couple seconds of clock slack.
      expect(ttl!).toBeGreaterThan(REFRESH_TOKEN_TTL_SECONDS - 5);
      expect(ttl!).toBeLessThanOrEqual(REFRESH_TOKEN_TTL_SECONDS);
    });

    it("skips members whose encoded expiry is already in the past", async () => {
      // Manually seed a stale member (hash with an exp in the past).
      const staleMember = "deadbeef:1"; // exp=1 (1970) → already expired
      setStore.set(SESSION_SET_PREFIX + "user-1", new Set([staleMember]));

      const count = await revokeUserSessions("user-1");
      // Nothing denylisted (already expired), but the set is still cleared.
      expect(count).toBe(0);
      const denyKeys = Array.from(scalarStore.keys()).filter((k) =>
        k.startsWith("jwt:deny:"),
      );
      expect(denyKeys).toHaveLength(0);
      expect(setStore.get(SESSION_SET_PREFIX + "user-1")).toBeUndefined();
    });
  });
});
