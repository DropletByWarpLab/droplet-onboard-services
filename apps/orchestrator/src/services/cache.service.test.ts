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
  invalidatePrefix,
  withSwrCache,
} from "./cache.service.js";

type Entry = { value: string; expiresAt: number };

function makeFakeRedis(opts: { errorOn?: "get" | "set" | "scan" } = {}) {
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
      ) => {
        if (opts.errorOn === "set") throw new Error("boom-set");
        store.set(k, {
          value: v,
          expiresAt: ttl ? Date.now() + ttl * 1000 : 0,
        });
        return "OK";
      },
    ),
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
