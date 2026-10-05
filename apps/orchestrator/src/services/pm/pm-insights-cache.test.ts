import { describe, it, expect, vi } from "vitest";
import { TtlCache } from "./pm-insights-cache.js";

const TTL = 5 * 60 * 1000;

describe("TtlCache (WARP-3524)", () => {
  it("serves the cached value until the TTL elapses, then recomputes", async () => {
    const cache = new TtlCache<number>(TTL, 8);
    const compute = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    expect(await cache.getOrCompute("k", 0, compute)).toBe(1);
    expect(await cache.getOrCompute("k", TTL - 1, compute)).toBe(1);
    expect(compute).toHaveBeenCalledTimes(1);

    // The entry is dead AT the TTL, not after it: `expiresAt > now` is the test.
    expect(await cache.getOrCompute("k", TTL, compute)).toBe(2);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("keys independently", async () => {
    const cache = new TtlCache<string>(TTL, 8);
    expect(await cache.getOrCompute("a", 0, async () => "A")).toBe("A");
    expect(await cache.getOrCompute("b", 0, async () => "B")).toBe("B");
    expect(await cache.getOrCompute("a", 1, async () => "stale?")).toBe("A");
  });

  it("shares one in-flight computation between concurrent callers", async () => {
    const cache = new TtlCache<number>(TTL, 8);
    let release!: (v: number) => void;
    const compute = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );
    const first = cache.getOrCompute("k", 0, compute);
    const second = cache.getOrCompute("k", 1, compute);
    release(7);
    expect(await Promise.all([first, second])).toEqual([7, 7]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("does not keep a failed computation", async () => {
    const cache = new TtlCache<number>(TTL, 8);
    const compute = vi
      .fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(3);

    await expect(cache.getOrCompute("k", 0, compute)).rejects.toThrow("db down");
    expect(cache.size).toBe(0);
    expect(await cache.getOrCompute("k", 1, compute)).toBe(3);
  });

  it("evicts the least recently used entry past the cap", async () => {
    const cache = new TtlCache<string>(TTL, 2);
    await cache.getOrCompute("a", 0, async () => "A");
    await cache.getOrCompute("b", 0, async () => "B");
    // Touch `a`, so `b` is now the oldest.
    await cache.getOrCompute("a", 1, async () => "A2");
    await cache.getOrCompute("c", 2, async () => "C");

    expect(cache.size).toBe(2);
    // `a` survived the eviction (and is touched again here)...
    expect(await cache.getOrCompute("a", 3, async () => "A3")).toBe("A");
    // ...while `b`, the oldest, was dropped and has to be recomputed.
    const recompute = vi.fn().mockResolvedValue("B2");
    expect(await cache.getOrCompute("b", 3, recompute)).toBe("B2");
    expect(recompute).toHaveBeenCalledTimes(1);
  });

  it("clear() drops everything", async () => {
    const cache = new TtlCache<number>(TTL, 8);
    await cache.getOrCompute("k", 0, async () => 1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(await cache.getOrCompute("k", 1, async () => 2)).toBe(2);
  });
});
