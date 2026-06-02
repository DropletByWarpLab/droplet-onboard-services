import Redis from "ioredis";
import pino from "pino";
import { config } from "../config.js";

const logger = pino({ name: "cache" });

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
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
