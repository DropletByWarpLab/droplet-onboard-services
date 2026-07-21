/**
 * WARP-836 — model-benchmark.service: measured tokens/sec from Ollama.
 *
 * Computes decode throughput from Ollama's own eval_count / eval_duration.
 * Any failure (non-2xx, missing timing, thrown) yields null — the card keeps
 * its honest "—", never a fabricated number.
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
});

describe("model-benchmark.service", () => {
  it("computes tokens/sec from Ollama eval timing", async () => {
    // 96 tokens in 2.259 s → ~42.5 tok/s.
    fetchMock.mockResolvedValue(
      jsonResp({ eval_count: 96, eval_duration: 2_259_000_000 }),
    );
    const r = await benchmarkModel("gpt-oss:20b");
    expect(r).not.toBeNull();
    expect(r!.tokensPerSec).toBeCloseTo(42.5, 1);
    expect(r!.evalCount).toBe(96);
    expect(r!.evalDurationMs).toBe(2259);
    expect(typeof r!.measuredAt).toBe("string");
  });

  it("returns null on a non-2xx generate", async () => {
    fetchMock.mockResolvedValue(jsonResp({}, false));
    expect(await benchmarkModel("x:1b")).toBeNull();
  });

  it("returns null when eval timing is missing (no fabrication)", async () => {
    fetchMock.mockResolvedValue(jsonResp({ response: "hi" }));
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
