/**
 * WARP-1118 — request-size estimator + degradation trigger (§10, the
 * Phase-0 overflow gate).
 *
 * The estimator sizes the WHOLE assembled request — system blocks +
 * serialized tools[] + pins + attachments + history — against the effective
 * window (config.OLLAMA_CONTEXT_LENGTH minus OUTPUT_RESERVE) and, when it
 * would overflow, DROPS blocks deterministically: business first (Phase 2),
 * then persona, then the existing history/attachment trimming. Each drop
 * logs a structured warn.
 *
 * WINDOW (corrected 2026-07-08): the shipping box runs 16384, wide enough
 * that a normal request never drops — these tests prove both the
 * nothing-drops-at-16384 happy path AND the forced-overflow degradation.
 */
import { describe, it, expect, vi } from "vitest";
import {
  estimateTokensFromChars,
  estimateRequestTokens,
  degradeToFit,
  DEFAULT_CONTEXT_WINDOW,
  type RequestSizeParts,
} from "./context-budget.service.js";
import { OUTPUT_RESERVE } from "./prompt-budget.consts.js";

/** A representative serialized tools[] payload — the shape ai-gateway sends
 *  the model. Big enough to be non-trivial in the estimate, small enough to
 *  fit the 16384 window alongside the fixed blocks. */
const REPRESENTATIVE_TOOLS_JSON = JSON.stringify(
  Array.from({ length: 12 }, (_, i) => ({
    type: "function",
    function: {
      name: `tool_${i}`,
      description:
        "A representative tool with a moderately long natural-language " +
        "description so the serialized schema resembles the real registry.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "the input query text" },
          limit: { type: "number", description: "max results to return" },
        },
        required: ["query"],
      },
    },
  })),
);

function parts(overrides: Partial<RequestSizeParts> = {}): RequestSizeParts {
  return {
    identityBlock: "identity",
    personaBlock: "",
    businessBlock: "",
    toolGuidance: "",
    memoryFactsBlock: "",
    toolSchemasJson: "",
    pinsText: "",
    attachmentsText: "",
    historyText: "",
    ...overrides,
  };
}

describe("estimateTokensFromChars", () => {
  it("uses the ~4-chars-per-token heuristic, rounding up", () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(5)).toBe(2);
    expect(estimateTokensFromChars(4000)).toBe(1000);
  });
});

describe("estimateRequestTokens", () => {
  it("sums every request component, not just the system blocks", () => {
    const withToolsOnly = estimateRequestTokens(
      parts({ identityBlock: "", toolSchemasJson: "x".repeat(4000) }),
    );
    const withHistoryToo = estimateRequestTokens(
      parts({
        identityBlock: "",
        toolSchemasJson: "x".repeat(4000),
        historyText: "y".repeat(4000),
      }),
    );
    expect(withHistoryToo).toBeGreaterThan(withToolsOnly);
    // 8000 chars ≈ 2000 tokens (identity zeroed for a clean arithmetic check).
    expect(withHistoryToo).toBe(2000);
  });
});

describe("degradeToFit — shipping 16384 window (nothing drops)", () => {
  it("keeps the persona (and would-be business) block at the real window", () => {
    const warn = vi.fn();
    // A realistic turn: identity + persona + business at their caps, memory
    // facts, a representative tools[] payload, and a chunk of history — all
    // well under 16384.
    const p = parts({
      identityBlock: "i".repeat(4000),
      personaBlock: "p".repeat(1200),
      businessBlock: "b".repeat(1500),
      memoryFactsBlock: "m".repeat(2000),
      toolSchemasJson: REPRESENTATIVE_TOOLS_JSON,
      historyText: "h".repeat(8000),
    });
    const result = degradeToFit(p, {
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      warn,
    });
    expect(result.dropped).toEqual([]);
    expect(result.personaBlock).toBe("p".repeat(1200));
    expect(result.businessBlock).toBe("b".repeat(1500));
    expect(result.historyTrimNeeded).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    // Sanity: the whole request really is under the effective window.
    expect(result.estimatedTokens).toBeLessThan(
      DEFAULT_CONTEXT_WINDOW - OUTPUT_RESERVE,
    );
  });
});

describe("degradeToFit — forced overflow", () => {
  it("keeps every block when the request already fits", () => {
    const warn = vi.fn();
    const p = parts({ personaBlock: "p", businessBlock: "b" });
    const result = degradeToFit(p, {
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      warn,
    });
    expect(result.personaBlock).toBe("p");
    expect(result.businessBlock).toBe("b");
    expect(result.dropped).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops the business block FIRST when over the threshold", () => {
    const warn = vi.fn();
    // A tiny window forces a drop with a representative tools[] + persona +
    // business present.
    const p = parts({
      identityBlock: "i".repeat(2000),
      personaBlock: "p".repeat(2000),
      businessBlock: "b".repeat(2000),
      toolSchemasJson: REPRESENTATIVE_TOOLS_JSON,
    });
    const result = degradeToFit(p, { contextWindow: 512, warn });
    expect(result.dropped[0]).toBe("business");
    expect(result.businessBlock).toBe("");
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toMatchObject({ block: "business" });
  });

  it("drops persona SECOND (only after business) and logs both in order", () => {
    const warn = vi.fn();
    const big = "x".repeat(2000);
    const p = parts({
      identityBlock: big,
      personaBlock: big,
      businessBlock: big,
      toolSchemasJson: REPRESENTATIVE_TOOLS_JSON,
    });
    const result = degradeToFit(p, { contextWindow: 512, warn });
    expect(result.dropped).toEqual(["business", "persona"]);
    expect(result.personaBlock).toBe("");
    // Structured warn on each drop, in order, each carrying the estimate +
    // threshold for observability.
    expect(warn.mock.calls.map((c) => c[0].block)).toEqual([
      "business",
      "persona",
    ]);
    const expectedThreshold = Math.max(0, 512 - OUTPUT_RESERVE);
    for (const call of warn.mock.calls) {
      expect(call[0]).toHaveProperty("estimatedTokens");
      expect(call[0].thresholdTokens).toBe(expectedThreshold);
    }
  });

  it("does NOT drop persona when dropping business alone brings it under", () => {
    const warn = vi.fn();
    // identity=400c(~100t), persona=400c(~100t), business=4000c(~1000t).
    const p = parts({
      identityBlock: "i".repeat(400),
      personaBlock: "p".repeat(400),
      businessBlock: "b".repeat(4000),
    });
    // threshold ≈ 300 tokens: identity+persona (~200t) fit, +business overflows.
    const result = degradeToFit(p, {
      contextWindow: OUTPUT_RESERVE + 300,
      warn,
    });
    expect(result.dropped).toEqual(["business"]);
    expect(result.personaBlock).toBe("p".repeat(400));
    expect(result.businessBlock).toBe("");
  });

  it("reports historyTrimNeeded when even a persona-less request overflows", () => {
    const warn = vi.fn();
    const big = "x".repeat(8000); // ~2000 tokens
    const p = parts({
      identityBlock: big,
      toolSchemasJson: big,
      historyText: big,
    });
    const result = degradeToFit(p, { contextWindow: 512, warn });
    // Nothing left to drop from the persona/business layer, so the caller is
    // told to fall through to the existing history/attachment trimming.
    expect(result.historyTrimNeeded).toBe(true);
  });
});
