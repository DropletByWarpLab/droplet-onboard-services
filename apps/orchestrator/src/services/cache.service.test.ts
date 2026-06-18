/**
 * WARP-90: tests for the SWR + prefix-invalidate helpers added to
 * cache.service.ts.
 *
 * Strategy:
 * - The global vitest setup mocks `ioredis` and leaves `REDIS_URL`
 *   unset, so `withSwrCache` and `invalidatePrefix` normally degrade
 *   to passthrough. That "no Redis" path is tested directly.
 * - For the caching and error-handling paths we stuff an in-memory
 *   fake into the module via `__setRedisForTesting` and toggle
 *   `process.env.REDIS_URL` for the duration of the test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  __setRedisForTesting,
  cacheIncr,
  cacheSetNx,
  invalidatePrefix,
  withSwrCache,
} from "./cache.service.js";

type Entry = { value: string; expiresAt: number };

function makeFakeRedis(opts: { errorOn?: "get" | "set" | "scan" | "eval" } = {}) {
  const store = new Map<string, Entry>();
  const api = {
    store,
    get: vi.fn(async (k: string) => {
      if (opts.errorOn === "get") throw new Error("boom-get");
      const e = store.get(k);
      if (!e) return null;
      if (e.expiresAt && Date.now() > e.expiresAt) {
        store.delete(k);
        return null;
      }
      return e.value;
    }),
    set: vi.fn(
      async (
        k: string,
        v: string,
        _mode?: string,
        ttl?: number,
        nx?: string,
      ) => {
        if (opts.errorOn === "set") throw new Error("boom-set");
        // Honor `SET … NX`: when the key already exists, redis replies null
        // and does not overwrite. This is what makes cacheSetNx atomic.
        if (nx === "NX") {
          const existing = store.get(k);
          const live =
            existing && (!existing.expiresAt || Date.now() <= existing.expiresAt);
          if (live) return null;
        }
        store.set(k, {
          value: v,
          expiresAt: ttl ? Date.now() + ttl * 1000 : 0,
        });
        return "OK";
      },
    ),
    incr: vi.fn(async (k: string) => {
      const e = store.get(k);
      const live = e && (!e.expiresAt || Date.now() <= e.expiresAt);
      const next = (live ? Number(e!.value) : 0) + 1;
      // INCR resets the TTL-less counter; EXPIRE is set separately (or via the
      // Lua eval path below), matching real Redis where INCR never touches TTL.
      store.set(k, { value: String(next), expiresAt: live ? e!.expiresAt : 0 });
      return next;
    }),
    expire: vi.fn(async (k: string, ttl: number, mode?: string) => {
      const e = store.get(k);
      if (!e) return 0;
      // EXPIRE … NX only sets a TTL when the key currently has none.
      if (mode === "NX" && e.expiresAt) return 0;
      e.expiresAt = Date.now() + ttl * 1000;
      return 1;
    }),
    // Fake EVAL just enough to run the cacheIncr Lua script: INCR the key, and
    // set the TTL only when the counter was freshly created (INCR returned 1).
    eval: vi.fn(async (_script: string, _numKeys: number, key: string, ttlArg: string) => {
      if (opts.errorOn === "eval") throw new Error("boom-eval");
      const e = store.get(key);
      const live = e && (!e.expiresAt || Date.now() <= e.expiresAt);
      const next = (live ? Number(e!.value) : 0) + 1;
      const expiresAt =
        next === 1 ? Date.now() + Number(ttlArg) * 1000 : live ? e!.expiresAt : 0;
      store.set(key, { value: String(next), expiresAt });
      return next;
    }),
    del: vi.fn(async (...keys: string[]) => {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    }),
    unlink: vi.fn(async (...keys: string[]) => {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    }),
    scan: vi.fn(
      async (
        _cursor: string,
        _matchKw: string,
        pattern: string,
        _countKw: string,
        _count: number,
      ) => {
        if (opts.errorOn === "scan") throw new Error("boom-scan");
        // Convert redis glob (`prefix*`) to a simple startsWith check —
        // good enough for our fake; the production code only ever calls
        // scan with `${prefix}*`.
        const prefix = pattern.endsWith("*")
          ? pattern.slice(0, -1)
          : pattern;
        const keys = Array.from(store.keys()).filter((k) =>
          k.startsWith(prefix),
        );
        // Return a single sweep — cursor "0" signals we're done.
        return ["0", keys] as [string, string[]];
      },
    ),
    ping: vi.fn(async () => "PONG"),
  };
  return api;
}

describe("cache.service (WARP-90)", () => {
  const originalRedisUrl = process.env.REDIS_URL;

  beforeEach(() => {
    __setRedisForTesting(null);
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    __setRedisForTesting(null);
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
  });

  describe("withSwrCache", () => {
    it("calls producer on every invocation when Redis is unavailable", async () => {
      // REDIS_URL unset -> passthrough
      const producer = vi.fn(async () => ({ n: 42 }));
      const a = await withSwrCache("k", 10, producer);
      const b = await withSwrCache("k", 10, producer);
      const c = await withSwrCache("k", 10, producer);
      expect(producer).toHaveBeenCalledTimes(3);
      expect(a).toEqual({ n: 42 });
      expect(b).toEqual({ n: 42 });
      expect(c).toEqual({ n: 42 });
    });

    it("caches the producer result and serves subsequent reads from Redis", async () => {
      process.env.REDIS_URL = "redis://fake";
      const fake = makeFakeRedis();
      __setRedisForTesting(fake as any);

      const producer = vi.fn(async () => ({ hello: "world" }));
      const first = await withSwrCache("net:devices:list:x", 30, producer);
      const second = await withSwrCache("net:devices:list:x", 30, producer);

      expect(first).toEqual({ hello: "world" });
      expect(second).toEqual({ hello: "world" });
      expect(producer).toHaveBeenCalledTimes(1);
      expect(fake.get).toHaveBeenCalledTimes(2);
      expect(fake.set).toHaveBeenCalledTimes(1);
      // Verify TTL was honored via the EX argument.
      expect(fake.set).toHaveBeenCalledWith(
        "net:devices:list:x",
        JSON.stringify({ hello: "world" }),
        "EX",
        30,
      );
    });

    it("falls through to producer and never throws on Redis GET errors", async () => {
      process.env.REDIS_URL = "redis://fake";
      const fake = makeFakeRedis({ errorOn: "get" });
      __setRedisForTesting(fake as any);

      const producer = vi.fn(async () => 7);
      const value = await withSwrCache("k", 5, producer);
      expect(value).toBe(7);
      expect(producer).toHaveBeenCalledTimes(1);
    });

    it("still returns the producer result when Redis SET fails", async () => {
      process.env.REDIS_URL = "redis://fake";
      const fake = makeFakeRedis({ errorOn: "set" });
      __setRedisForTesting(fake as any);

      const producer = vi.fn(async () => ({ ok: true }));
      const value = await withSwrCache("k", 5, producer);
      expect(value).toEqual({ ok: true });
      expect(producer).toHaveBeenCalledTimes(1);
      // Next call: SET failed last time so store is empty -> producer runs again.
      const value2 = await withSwrCache("k", 5, producer);
      expect(value2).toEqual({ ok: true });
      expect(producer).toHaveBeenCalledTimes(2);
    });
  });

  describe("cacheSetNx (ORCH-03 atomic claim)", () => {
    it("grants the claim once and refuses every subsequent claim on the same key", async () => {
      process.env.REDIS_URL = "redis://fake";
      const fake = makeFakeRedis();
      __setRedisForTesting(fake as any);

      const first = await cacheSetNx("jwt:rotate:tok", true, 30);
      const second = await cacheSetNx("jwt:rotate:tok", true, 30);
      const third = await cacheSetNx("jwt:rotate:tok", true, 30);

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(third).toBe(false);
      // Issued as a single SET … EX … NX round-trip (atomic), not GET+SET.
      expect(fake.set).toHaveBeenCalledWith(
        "jwt:rotate:tok",
        JSON.stringify(true),
        "EX",
        30,
        "NX",
      );
    });

    it("lets exactly ONE of many concurrent claims win the same token (TOCTOU proof)", async () => {
      process.env.REDIS_URL = "redis://fake";
      const fake = makeFakeRedis();
      __setRedisForTesting(fake as any);

      // Fire 12 claims for the same key concurrently. With a non-atomic
      // GET-then-SET, several would observe "absent" and all win; the atomic
      // NX write guarantees a single winner — the property ORCH-03 requires.
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          cacheSetNx("jwt:rotate:concurrent", true, 30),
        ),
      );
      expect(results.filter((r) => r === true)).toHaveLength(1);
      expect(results.filter((r) => r === false)).toHaveLength(11);
    });

    it("returns false (fail-closed) on a Redis SET error", async () => {
      process.env.REDIS_URL = "redis://fake";
      const fake = makeFakeRedis({ errorOn: "set" });
      __setRedisForTesting(fake as any);

      const won = await cacheSetNx("jwt:rotate:err", true, 30);
      expect(won).toBe(false);
    });
  });

  describe("cacheIncr (fixed-window rate-limit counter)", () => {
    it("increments and returns the running count", async () => {
      process.env.REDIS_URL = "redis://fake";
      const fake = makeFakeRedis();
      __setRedisForTesting(fake as any);

      expect(await cacheIncr("rl:ip", 60)).toBe(1);
      expect(await cacheIncr("rl:ip", 60)).toBe(2);
      expect(await cacheIncr("rl:ip", 60)).toBe(3);
    });

    it("sets the TTL only when the key is first created (fixed, not sliding, window)", async () => {
      process.env.REDIS_URL = "redis://fake";
      const fake = makeFakeRedis();
      __setRedisForTesting(fake as any);

      // First call creates the key and stamps a TTL ~60s out.
      await cacheIncr("rl:ip", 60);
      const firstExpiry = fake.store.get("rl:ip")!.expiresAt;
      expect(firstExpiry).toBeGreaterThan(0);

      // A later call within the window must NOT push the expiry out — that would
      // make the window slide and the counter never reset (the Finding-2 bug).
      await new Promise((r) => setTimeout(r, 15));
      await cacheIncr("rl:ip", 60);
      const secondExpiry = fake.store.get("rl:ip")!.expiresAt;
      expect(secondExpiry).toBe(firstExpiry);
    });

    it("never leaves the key TTL-less (the EXPIRE always lands atomically with INCR)", async () => {
      process.env.REDIS_URL = "redis://fake";
      const fake = makeFakeRedis();
      __setRedisForTesting(fake as any);

      await cacheIncr("rl:ip", 60);
      // The very first increment must carry a TTL; a non-atomic INCR-then-EXPIRE
      // could crash between the two and strand the key forever.
      expect(fake.store.get("rl:ip")!.expiresAt).toBeGreaterThan(0);
    });

    it("returns null (caller fails OPEN) on a Redis error", async () => {
      process.env.REDIS_URL = "redis://fake";
      const fake = makeFakeRedis({ errorOn: "eval" });
      __setRedisForTesting(fake as any);

      expect(await cacheIncr("rl:ip", 60)).toBeNull();
    });
  });

  describe("invalidatePrefix", () => {
    it("returns 0 and is a no-op when Redis is unavailable", async () => {
      const n = await invalidatePrefix("network:devices:");
      expect(n).toBe(0);
    });

    it("deletes matching keys and leaves others intact", async () => {
      process.env.REDIS_URL = "redis://fake";
      const fake = makeFakeRedis();
      __setRedisForTesting(fake as any);

      // Seed three matching entries + one unrelated.
      await withSwrCache("network:devices:list:all:none", 60, async () => 1);
      await withSwrCache("network:devices:list:online:none", 60, async () => 2);
      await withSwrCache("network:devices:list:all:grp-a", 60, async () => 3);
      await withSwrCache("network:groups:list", 60, async () => ["g1"]);

      expect(fake.store.size).toBe(4);

      const n = await invalidatePrefix("network:devices:");
      expect(n).toBe(3);
      expect(fake.store.size).toBe(1);
      expect(fake.store.has("network:groups:list")).toBe(true);
    });

    it("returns 0 and swallows errors when SCAN fails", async () => {
      process.env.REDIS_URL = "redis://fake";
      const fake = makeFakeRedis({ errorOn: "scan" });
      __setRedisForTesting(fake as any);

      const n = await invalidatePrefix("network:devices:");
      expect(n).toBe(0);
    });
  });
});
