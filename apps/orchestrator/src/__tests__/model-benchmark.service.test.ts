/**
 * WARP-836 / WARP-1772 — model-benchmark.service: measured tokens/sec on the
 * runtime-agnostic OpenAI chat path.
 *
 * Computes wall-clock throughput from `usage.completion_tokens` — the only
 * form both Ollama and DMR can answer (DMR has no /api/generate and no native
 * timing fields). Any failure (non-2xx, missing usage, thrown) yields null —
 * the card keeps its honest "—", never a fabricated number.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  benchmarkModel,
  benchCacheKey,
} from "../services/model-benchmark.service.js";

function jsonResp(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("model-benchmark.service", () => {
  it("POSTs the OpenAI chat path (both runtimes serve it) with a bounded budget", async () => {
    fetchMock.mockResolvedValue(
      jsonResp({ usage: { completion_tokens: 96 } }),
    );
    const r = await benchmarkModel("gpt-oss:20b");
    expect(r).not.toBeNull();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toMatch(/\/v1\/chat\/completions$/);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe("gpt-oss:20b");
    expect(body.max_tokens).toBe(96);
    expect(body.stream).toBe(false);
  });

  it("computes tokens/sec from usage.completion_tokens over wall clock", async () => {
    // Simulate a generation that takes ~2s of wall clock.
    let nowMs = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => {
      const v = nowMs;
      nowMs += 2_000; // second call (after fetch) is 2s later
      return v;
    });
    fetchMock.mockResolvedValue(
      jsonResp({ usage: { completion_tokens: 96 } }),
    );
    const r = await benchmarkModel("gpt-oss:20b");
    expect(r).not.toBeNull();
    // 96 tokens / 2 s = 48.0 tok/s
    expect(r!.tokensPerSec).toBeCloseTo(48.0, 1);
    expect(r!.evalCount).toBe(96);
    expect(r!.evalDurationMs).toBe(2000);
    expect(typeof r!.measuredAt).toBe("string");
  });

  it("returns null on a non-2xx response", async () => {
    fetchMock.mockResolvedValue(jsonResp({}, false));
    expect(await benchmarkModel("x:1b")).toBeNull();
  });

  it("returns null when usage tokens are missing (no fabrication)", async () => {
    fetchMock.mockResolvedValue(jsonResp({ choices: [] }));
    expect(await benchmarkModel("x:1b")).toBeNull();
  });

  it("returns null when the request throws", async () => {
    fetchMock.mockRejectedValue(new Error("connection refused"));
    expect(await benchmarkModel("x:1b")).toBeNull();
  });

  it("benchCacheKey normalises bare names", () => {
    expect(benchCacheKey("gpt-oss")).toBe("models:bench:gpt-oss:latest");
    expect(benchCacheKey("gpt-oss:20b")).toBe("models:bench:gpt-oss:20b");
  });
});
