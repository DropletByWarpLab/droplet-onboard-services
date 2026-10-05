/**
 * WARP-3524 — the in-process cache behind `GET /api/pm/insights`.
 *
 * A TTL map with a size cap and single-flight: two requests for the same key
 * that arrive before the first finishes share ONE computation (the insights
 * queries scan every work item and activity row in scope, so a refresh storm
 * must not become N scans). Evicts least-recently-used when full.
 *
 * Deliberately NOT `services/cache.service.ts`: that one is a Redis
 * stale-while-revalidate cache which degrades to a no-op without `REDIS_URL`,
 * and the insights contract is "cached for 5 minutes" whether or not a box has
 * Redis. One orchestrator process per box, so a per-process map is the whole
 * story; a restart simply recomputes.
 *
 * The caller passes the clock (`nowMs`) so a test can step past the TTL without
 * fake timers, and so the cache and the computation it guards agree on "now".
 * A computation that rejects is never kept: the next request retries.
 */

interface Entry<V> {
  expiresAt: number;
  value: Promise<V>;
}

export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  async getOrCompute(key: string, nowMs: number, compute: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > nowMs) {
      // Re-insert so the Map's insertion order doubles as recency order.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value;
    }
    const entry: Entry<V> = { expiresAt: nowMs + this.ttlMs, value: compute() };
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    // A failed computation must not be served for the rest of the TTL. The
    // caller still sees the rejection through `entry.value` below.
    entry.value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry.value;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
