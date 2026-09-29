/**
 * WARP-3193 QUAL-6 — the shared transport the per-vendor REST connectors send
 * through. Pins the security-relevant properties once, for every adopter:
 * never follow a redirect, always carry a timeout, never dial when there is no
 * fetch, and bound the 429 loop.
 */
import { describe, expect, it, vi } from "vitest";
import { SafeRestTransport, type SafeRestPolicy } from "../src/rest/safe-transport.js";

function res(status: number): Response {
  return { status, ok: status >= 200 && status < 300 } as Response;
}

function policy(over: Partial<SafeRestPolicy> = {}): SafeRestPolicy {
  return {
    maxAttempts: 3,
    noFetch: () => new Error("no fetch"),
    unreachable: (err) => new Error(`unreachable: ${err.message}`),
    rateLimited: (_r, attempt, final) => {
      if (final) throw new Error(`429 after ${attempt + 1}`);
      return 10 * (attempt + 1);
    },
    ...over,
  };
}

const REQ = { url: "https://api.example.com/v1/x", method: "GET", headers: { A: "b" } };

describe("SafeRestTransport (WARP-3193 QUAL-6)", () => {
  it("refuses redirects, sets a timeout signal, and returns the first non-429 response", async () => {
    const fetchImpl = vi.fn(async () => res(200));
    const t = new SafeRestTransport({
      fetchImpl,
      timeoutMs: 5_000,
      sleep: async () => undefined,
    });
    const out = await t.send(REQ, policy());
    expect(out.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(url).toBe(REQ.url);
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ A: "b" });
    expect("body" in init).toBe(false);
  });

  it("passes a body through only when one is given", async () => {
    const fetchImpl = vi.fn(async () => res(200));
    const t = new SafeRestTransport({ fetchImpl, timeoutMs: 1, sleep: async () => undefined });
    await t.send({ ...REQ, method: "POST", body: "a=1" }, policy());
    const init = (fetchImpl.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(init.body).toBe("a=1");
  });

  it("retries a 429 after the policy's wait and stops at maxAttempts with the policy's error", async () => {
    const fetchImpl = vi.fn(async () => res(429));
    const sleep = vi.fn(async () => undefined);
    const t = new SafeRestTransport({ fetchImpl, timeoutMs: 1, sleep });
    await expect(t.send(REQ, policy())).rejects.toThrow("429 after 3");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
  });

  it("returns a non-429 error response to the caller for classification", async () => {
    const fetchImpl = vi
      .fn<(u: string, i?: Record<string, unknown>) => Promise<Response>>()
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(403));
    const t = new SafeRestTransport({ fetchImpl, timeoutMs: 1, sleep: async () => undefined });
    expect((await t.send(REQ, policy())).status).toBe(403);
  });

  it("maps a network failure through the policy", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const t = new SafeRestTransport({ fetchImpl, timeoutMs: 1, sleep: async () => undefined });
    await expect(t.send(REQ, policy())).rejects.toThrow("unreachable: ECONNREFUSED");
  });

  it("dials nothing when there is no fetch implementation", async () => {
    const original = globalThis.fetch;
    // @ts-expect-error — simulating a runtime without fetch
    globalThis.fetch = undefined;
    try {
      const t = new SafeRestTransport({ timeoutMs: 1, sleep: async () => undefined });
      await expect(t.send(REQ, policy())).rejects.toThrow("no fetch");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("runs beforeAttempt before every attempt", async () => {
    const fetchImpl = vi
      .fn<(u: string, i?: Record<string, unknown>) => Promise<Response>>()
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(200));
    const beforeAttempt = vi.fn(async () => undefined);
    const t = new SafeRestTransport({ fetchImpl, timeoutMs: 1, sleep: async () => undefined });
    await t.send(REQ, policy({ beforeAttempt }));
    expect(beforeAttempt).toHaveBeenCalledTimes(2);
  });
});
