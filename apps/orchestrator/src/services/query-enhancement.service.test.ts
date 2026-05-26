import { describe, expect, it, vi } from "vitest";
import {
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
