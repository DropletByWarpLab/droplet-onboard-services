import Redis from "ioredis";
import { readFileSync } from "node:fs";
import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("cache");

let redis: Redis | null = null;

/** WARP-234: CA path for the rediss:// listener — the WARP-236 per-service
 *  bundle mount (compose) or DROPLET_TLS_CA (same env contract as
 *  lib/internal-tls.ts). */
export function redisCaPath(): string {
  return process.env.DROPLET_TLS_CA ?? "/data/service-tls/ca.pem";
}

/** WARP-234: for a rediss:// URL, pin trust to the compose-internal CA —
 *  the cache serves a WARP-236 leaf, which no public root signs. Plaintext
 *  redis:// URLs (dev compose) get no TLS options. `readCa` is injectable
 *  for tests. */
export function redisConnectionOptions(
  url: string,
  readCa: (path: string) => Buffer = (p) => readFileSync(p),
): { tls?: { ca: Buffer } } {
  if (!url.startsWith("rediss://")) return {};
  return { tls: { ca: readCa(redisCaPath()) } };
}

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      // ioredis 6 made RESP3 the default. Nothing we issue (GET/SET/SETEX/DEL/
      // EXISTS/EXPIRE/ZADD/ZRANGE/ZREM/EVAL/PING/SCAN/UNLINK) has a different
      // RESP3 reply shape, but ioredis 6 does NOT fall back when HELLO 3 is
      // refused — it throws — so a REDIS_URL pointed at anything older than
      // Redis 6 would go from "works" to "cannot connect". Pin the v5 wire
      // protocol so this dependency bump is byte-identical on the wire; adopt
      // RESP3 deliberately, on its own, when we want its features.
      protocol: 2,
      ...redisConnectionOptions(config.REDIS_URL),
    });
  }
  return redis;
}

/**
 * WARP-90: returns a Redis client if caching is enabled, or null if it
 * should passthrough (`REDIS_URL` unset). We intentionally consult
 * `process.env.REDIS_URL` directly rather than `config.REDIS_URL` —
 * `config` applies a default at parse time, so checking `process.env`
 * preserves the distinction between "explicitly configured" and
 * "defaulted for dev". In the vitest setup `REDIS_URL` is unset, so
 * `withSwrCache` and `invalidatePrefix` degrade to no-ops without any
 * per-test plumbing.
 */
function maybeRedis(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  try {
    return getRedis();
  } catch {
    return null;
  }
}

/**
 * Test-only hook so cache.service.test.ts can inject a fake redis client.
 * Keeps the production path free of conditional branches while letting
 * the test suite exercise hit / miss / error behavior deterministically.
 */
export function __setRedisForTesting(client: Redis | null): void {
  redis = client;
}

export async function connectRedis(): Promise<void> {
  const client = getRedis();
  await client.connect();
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const val = await getRedis().get(key);
    return val ? (JSON.parse(val) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number = 60
): Promise<void> {
  try {
    await getRedis().set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    // Cache failures are non-fatal
  }
}

/**
 * Atomic set-if-not-exists. Writes `value` only when `key` does not already
 * exist, with a TTL, in a single Redis round-trip (`SET … NX EX`). Returns
 * `true` when the caller created the key (won the race), `false` when the key
 * already existed (lost the race).
 *
 * Unlike `cacheGet`/`cacheSet`, this is a correctness primitive, not an
 * optimization: it backs the refresh-token rotation claim (jwt.service), where
 * a non-atomic check-then-set lets two concurrent callers both "win". For that
 * reason it fails CLOSED — any Redis error (or a missing client) returns
 * `false` (claim not granted) rather than silently succeeding. A caller that
 * gets `false` must reject the operation it was guarding.
 */
export async function cacheSetNx(
  key: string,
  value: unknown,
  ttlSeconds: number = 60,
): Promise<boolean> {
  try {
    const reply = await getRedis().set(
      key,
      JSON.stringify(value),
      "EX",
      ttlSeconds,
      "NX",
    );
    // ioredis returns "OK" when the key was set, null when NX prevented it.
    return reply === "OK";
  } catch {
    // Fail closed: a security primitive must not grant the claim on a Redis
    // outage. Returning false makes the guarded caller reject.
    return false;
  }
}

export async function cacheDel(key: string): Promise<void> {
  try {
    await getRedis().del(key);
  } catch {
    // Cache failures are non-fatal
  }
}

/**
 * WARP-116: add `member` to the Redis set at `key` (SADD), and bump the
 * whole set's TTL so a forgotten/abandoned index self-cleans rather than
 * leaking refresh-token hashes forever. `EXPIRE … GT` only ever extends the
 * TTL (never shortens it), so concurrent device logins each push the expiry
 * out to the longest-lived member without clobbering each other.
 *
 * Used to index the live refresh-token sessions for a user so the
 * revoke-sessions admin endpoint can denylist them all at once. Non-fatal
 * on Redis error: a missed index write only means that one session can't be
 * force-revoked early — it still expires on its own ≤7-day TTL.
 */
export async function cacheSetAdd(
  key: string,
  member: string,
  ttlSeconds?: number,
): Promise<void> {
  try {
    const client = getRedis();
    await client.sadd(key, member);
    if (ttlSeconds && ttlSeconds > 0) {
      // GT: only extend, never shrink, the set's TTL.
      await client.expire(key, ttlSeconds, "GT");
    }
  } catch {
    // Cache failures are non-fatal
  }
}

/**
 * WARP-116: remove `member` from the Redis set at `key` (SREM). Used on
 * logout to drop that device's refresh-token member from the session index.
 * Non-fatal on Redis error.
 */
export async function cacheSetRemove(key: string, member: string): Promise<void> {
  try {
    await getRedis().srem(key, member);
  } catch {
    // Cache failures are non-fatal
  }
}

/**
 * WARP-116: read every member of the Redis set at `key` (SMEMBERS). Returns
 * an empty array on a miss or Redis error so callers can treat "no Redis" the
 * same as "no sessions" without special-casing.
 */
export async function cacheSetMembers(key: string): Promise<string[]> {
  try {
    return await getRedis().smembers(key);
  } catch {
    return [];
  }
}

/**
 * Atomic fixed-window increment. Runs INCR and a first-creation-only EXPIRE in
 * a single Lua script (one server round-trip, executed atomically by Redis), so:
 *
 *   - the counter and its TTL can never diverge — there is no window between the
 *     two commands in which a crash/Redis-error leaves the key TTL-less and the
 *     limiter stuck "tripped" forever (the old INCR-then-EXPIRE bug); and
 *   - the TTL is stamped ONLY when the counter is first created (INCR == 1), so
 *     the window is FIXED: it expires `ttlSeconds` after the first hit and the
 *     counter resets, instead of sliding forward on every call (which would let
 *     a steady trickle of requests keep the key — and thus the limit — alive
 *     indefinitely, contradicting the "resets after the window" intent).
 *
 * Returns the new counter value, or null on a Redis error (caller fails OPEN).
 */
const INCR_FIXED_WINDOW_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return n
`;

export async function cacheIncr(
  key: string,
  ttlSeconds: number,
): Promise<number | null> {
  try {
    const next = (await getRedis().eval(
      INCR_FIXED_WINDOW_LUA,
      1,
      key,
      String(ttlSeconds),
    )) as number;
    return next;
  } catch {
    return null;
  }
}

export async function isRedisHealthy(): Promise<boolean> {
  try {
    const pong = await getRedis().ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}

/**
 * WARP-90: stale-while-revalidate cache primitive.
 *
 * If the key is fresh (`GET key` hits), return the cached value. Otherwise
 * call `producer()`, cache the result with `ttlSec` TTL, and return it.
 *
 * When Redis is unavailable (`REDIS_URL` unset, client missing, or any
 * Redis error on the call) this degrades to pure passthrough: `producer`
 * is invoked and its result returned, and the caller never sees a cache
 * error. Caching is an optimization — never a correctness path.
 */
export async function withSwrCache<T>(
  key: string,
  ttlSec: number,
  producer: () => Promise<T>,
): Promise<T> {
  const client = maybeRedis();
  if (!client) {
    return producer();
  }
  try {
    const raw = await client.get(key);
    if (raw != null) {
      return JSON.parse(raw) as T;
    }
  } catch (err) {
    logger.warn({ err, key }, "cache GET failed; falling through to producer");
    return producer();
  }
  const value = await producer();
  try {
    await client.set(key, JSON.stringify(value), "EX", ttlSec);
  } catch (err) {
    logger.warn({ err, key }, "cache SET failed; value will not be cached");
  }
  return value;
}

/**
 * WARP-90: delete every cached key starting with `prefix` using a
 * non-blocking SCAN + UNLINK sweep. Returns the number of keys removed.
 *
 * Uses UNLINK (asynchronous free) when supported and falls back to DEL
 * otherwise. When Redis is unavailable this is a no-op that returns 0 —
 * write-through invalidation never fails a mutation.
 */
export async function invalidatePrefix(prefix: string): Promise<number> {
  const client = maybeRedis();
  if (!client) return 0;
  const match = `${prefix}*`;
  let cursor = "0";
  let deleted = 0;
  try {
    do {
      const [nextCursor, keys] = (await client.scan(
        cursor,
        "MATCH",
        match,
        "COUNT",
        100,
      )) as [string, string[]];
      cursor = nextCursor;
      if (keys.length > 0) {
        // Prefer UNLINK (non-blocking); fall back to DEL if the Redis
        // build doesn't support it. Both return a count of keys removed.
        const unlink = (client as unknown as {
          unlink?: (...k: string[]) => Promise<number>;
        }).unlink;
        const n = unlink
          ? await unlink.call(client, ...keys)
          : await client.del(...keys);
        deleted += n ?? 0;
      }
    } while (cursor !== "0");
  } catch (err) {
    logger.warn({ err, prefix }, "cache invalidatePrefix failed");
    return deleted;
  }
  return deleted;
}
