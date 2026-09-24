import { afterEach, describe, expect, it, vi } from "vitest";

// WARP-3047 — the production chat adapter's gateway call, observed.
const gatewayChat = vi.hoisted(() => vi.fn());
vi.mock("./ai-gateway.client.js", () => ({ chat: gatewayChat }));

import {
  classifyQuery,
  CLASSIFIER_CACHE_TTL_SEC,
  createEnhancementDeps,
  hydeRewrite,
  multiQueryExpand,
  MULTI_QUERY_DEFAULT_N,
} from "./query-enhancement.service.js";

describe("hydeRewrite", () => {
  it("returns the passage from ai-gateway chat", async () => {
    const chat = vi.fn().mockResolvedValue({ content: "Paris is the capital of France." });
    const out = await hydeRewrite({ query: "capital of france?", chat });
    expect(out).toBe("Paris is the capital of France.");
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("returns the raw query on chat failure", async () => {
    const chat = vi.fn().mockRejectedValue(new Error("boom"));
    const out = await hydeRewrite({ query: "x", chat });
    expect(out).toBe("x");
  });
});

describe("multiQueryExpand", () => {
  it("parses a 3-element JSON array from chat output", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: '["q1", "q2", "q3"]',
    });
    const out = await multiQueryExpand({ query: "x", chat });
    expect(out).toEqual(["q1", "q2", "q3"]);
  });

  it("falls back to [query] on parse failure", async () => {
    const chat = vi.fn().mockResolvedValue({ content: "not json" });
    const out = await multiQueryExpand({ query: "x", chat });
    expect(out).toEqual(["x"]);
  });

  it("clamps n to the requested count if model over-produces", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: '["q1", "q2", "q3", "q4", "q5"]',
    });
    const out = await multiQueryExpand({ query: "x", chat, n: 3 });
    expect(out).toHaveLength(3);
  });

  it("default n equals MULTI_QUERY_DEFAULT_N", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: '["a","b","c","d","e"]',
    });
    const out = await multiQueryExpand({ query: "x", chat });
    expect(out).toHaveLength(MULTI_QUERY_DEFAULT_N);
  });
});

describe("classifyQuery", () => {
  it("returns the class + confidence from the gRPC client", async () => {
    const rpc = vi.fn().mockResolvedValue({ class: "factual", confidence: 0.91 });
    const out = await classifyQuery({ query: "what is x", rpc, cache: makeMemoryCache() });
    expect(out).toEqual({ cls: "factual", confidence: 0.91 });
  });

  it("caches by query SHA-256 with TTL", async () => {
    const rpc = vi.fn().mockResolvedValue({ class: "factual", confidence: 0.9 });
    const cache = makeMemoryCache();
    await classifyQuery({ query: "x", rpc, cache });
    await classifyQuery({ query: "x", rpc, cache });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("falls back to 'unknown' on RPC failure", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("boom"));
    const out = await classifyQuery({ query: "x", rpc, cache: makeMemoryCache() });
    expect(out.cls).toBe("unknown");
  });

  it("falls back to 'unknown' when RPC returns an unrecognized class", async () => {
    const rpc = vi.fn().mockResolvedValue({ class: "unexpected_class", confidence: 0.42 });
    const out = await classifyQuery({ query: "x", rpc, cache: makeMemoryCache() });
    expect(out.cls).toBe("unknown");
    expect(out.confidence).toBe(0.42);
  });

  it("exports a 24h TTL constant", () => {
    expect(CLASSIFIER_CACHE_TTL_SEC).toBe(24 * 60 * 60);
  });
});

function makeMemoryCache() {
  const store = new Map<string, { v: string; exp: number }>();
  return {
    async get(k: string) {
      const e = store.get(k);
      if (!e) return null;
      if (e.exp < Date.now()) {
        store.delete(k);
        return null;
      }
      return e.v;
    },
    async setex(k: string, ttl: number, v: string) {
      store.set(k, { v, exp: Date.now() + ttl * 1000 });
    },
  };
}

describe("createEnhancementDeps (WARP-437 production factory)", () => {
  const orig = process.env.QUERY_ENHANCEMENT_ENABLED;
  afterEach(() => {
    if (orig === undefined) delete process.env.QUERY_ENHANCEMENT_ENABLED;
    else process.env.QUERY_ENHANCEMENT_ENABLED = orig;
  });

  it("returns undefined when QUERY_ENHANCEMENT_ENABLED is not '1'", () => {
    delete process.env.QUERY_ENHANCEMENT_ENABLED;
    const out = createEnhancementDeps({
      aiGatewayGrpcUrl: "ai-gateway:50051",
      resolveModel: async () => "test-model",
    });
    expect(out).toBeUndefined();
  });

  it("returns undefined for any non-'1' value (e.g. 'true', '0', '')", () => {
    for (const v of ["true", "0", "", "yes"]) {
      process.env.QUERY_ENHANCEMENT_ENABLED = v;
      const out = createEnhancementDeps({
        aiGatewayGrpcUrl: "ai-gateway:50051",
        resolveModel: async () => "test-model",
      });
      expect(out).toBeUndefined();
    }
  });

  it("returns a deps object with all 4 methods when flag is '1'", () => {
    process.env.QUERY_ENHANCEMENT_ENABLED = "1";
    const out = createEnhancementDeps({
      aiGatewayGrpcUrl: "ai-gateway:50051",
      resolveModel: async () => "test-model",
    });
    expect(out).toBeDefined();
    expect(typeof out?.classify).toBe("function");
    expect(typeof out?.hyde).toBe("function");
    expect(typeof out?.multiQuery).toBe("function");
    expect(typeof out?.embed).toBe("function");
  });

  it("asks for the rewrite model LAZILY and sends exactly that model (WARP-3047)", async () => {
    process.env.QUERY_ENHANCEMENT_ENABLED = "1";
    gatewayChat.mockReset();
    gatewayChat.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "A passage." } }] }),
    });
    const resolveModel = vi.fn(async () => "docker.io/ai/qwen3:8B-Q4_K_M");
    const out = createEnhancementDeps({ aiGatewayGrpcUrl: "ai-gateway:50051", resolveModel });
    // Building the deps (every /llm/chat turn) costs no resolution at all.
    expect(resolveModel).not.toHaveBeenCalled();

    await expect(out?.hyde("where is the invoice?")).resolves.toBe("A passage.");
    expect(resolveModel).toHaveBeenCalledTimes(1);
    expect(gatewayChat.mock.calls[0][0].model).toBe("docker.io/ai/qwen3:8B-Q4_K_M");
  });

  it("no resolvable model → no gateway call, the raw query stands (WARP-3047)", async () => {
    process.env.QUERY_ENHANCEMENT_ENABLED = "1";
    gatewayChat.mockReset();
    const out = createEnhancementDeps({
      aiGatewayGrpcUrl: "ai-gateway:50051",
      resolveModel: async () => null,
    });
    await expect(out?.hyde("where is the invoice?")).resolves.toBe("where is the invoice?");
    expect(gatewayChat).not.toHaveBeenCalled();
  });
});
