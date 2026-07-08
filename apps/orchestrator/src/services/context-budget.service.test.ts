/**
 * WARP-1118 — request-size estimator + degradation trigger (§10, the
 * Phase-0 overflow gate).
 *
 * The box runs Ollama's default 4096-token num_ctx and the owner-role tool
 * list alone has already overflowed it (WARP-854). This estimator sizes the
 * WHOLE assembled request — system blocks + serialized tools[] + pins +
 * attachments + history — against the effective window (num_ctx minus an
 * output reserve) and, when it would overflow, DROPS blocks deterministically:
 *   business block first (Phase 2), then persona block, then the existing
 * history/attachment trimming. Each drop logs a structured warn.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  estimateTokensFromChars,
  estimateRequestTokens,
  degradeToFit,
  OUTPUT_TOKEN_RESERVE,
  BASE_PROMPT_MAX_CHARS,
  DEFAULT_NUM_CTX,
  type RequestSizeParts,
} from "./context-budget.service.js";

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

describe("degradeToFit", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps every block when the request already fits", () => {
    const warn = vi.fn();
    const p = parts({ personaBlock: "p", businessBlock: "b" });
    const result = degradeToFit(p, { numCtx: DEFAULT_NUM_CTX, warn });
    expect(result.personaBlock).toBe("p");
    expect(result.businessBlock).toBe("b");
    expect(result.dropped).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops the business block FIRST when over the threshold", () => {
    const warn = vi.fn();
    // Force overflow with a tiny window so only one drop is needed.
    const big = "x".repeat(2000); // ~500 tokens each
    const p = parts({
      identityBlock: big,
      personaBlock: big,
      businessBlock: big,
    });
    const result = degradeToFit(p, { numCtx: 512, warn });
    expect(result.businessBlock).toBe("");
    // persona still present after only-one-drop-needed... but the window is
    // tiny, so persona goes too. Assert ORDER via the dropped log instead.
    expect(result.dropped[0]).toBe("business");
    expect(warn).toHaveBeenCalled();
    const firstWarn = warn.mock.calls[0][0];
    expect(firstWarn).toMatchObject({ block: "business" });
  });

  it("drops persona SECOND (only after business) and logs both in order", () => {
    const warn = vi.fn();
    const big = "x".repeat(2000);
    const p = parts({
      identityBlock: big,
      personaBlock: big,
      businessBlock: big,
    });
    const result = degradeToFit(p, { numCtx: 512, warn });
    expect(result.dropped).toEqual(["business", "persona"]);
    expect(result.personaBlock).toBe("");
    // Structured warn on each drop, in order.
    expect(warn.mock.calls.map((c) => c[0].block)).toEqual([
      "business",
      "persona",
    ]);
    // Each warn carries the estimate + threshold for observability.
    for (const call of warn.mock.calls) {
      expect(call[0]).toHaveProperty("estimatedTokens");
      expect(call[0]).toHaveProperty("thresholdTokens");
    }
  });

  it("does NOT drop persona when dropping business alone brings it under", () => {
    const warn = vi.fn();
    // Window sized so identity+persona fit but +business overflows.
    // identity=400c(~100t), persona=400c(~100t), business=4000c(~1000t).
    const p = parts({
      identityBlock: "i".repeat(400),
      personaBlock: "p".repeat(400),
      businessBlock: "b".repeat(4000),
    });
    // effective = numCtx - reserve. Choose numCtx so threshold ~= 300 tokens.
    const result = degradeToFit(p, {
      numCtx: OUTPUT_TOKEN_RESERVE + 300,
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
    const result = degradeToFit(p, { numCtx: 512, warn });
    // Nothing left to drop from the persona/business layer, so the caller
    // is told to fall through to the existing history/attachment trimming.
    expect(result.historyTrimNeeded).toBe(true);
  });
});

describe("BASE_PROMPT_MAX_CHARS worst-case ceiling", () => {
  it("is 10000", () => {
    expect(BASE_PROMPT_MAX_CHARS).toBe(10000);
  });
});
