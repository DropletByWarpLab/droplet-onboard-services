/**
 * WARP-458 — reasoning-trace parser unit tests.
 *
 * The parser is a pure function exported from `llm-agent.service.ts`. It
 * handles three input shapes the agent loop sees in practice:
 *
 *   1. Inline `<reasoning>…</reasoning>` segments interleaved with the
 *      model's user-visible content (the qwen3 / deepseek-r1 family).
 *   2. A separately-supplied `reasoning` string from the provider's
 *      native reasoning field (OpenAI o-series via LiteLLM, Anthropic
 *      extended-thinking when exposed). When both inline tags AND a
 *      native field are present (rare), they are concatenated in the
 *      order the parser receives them — native first, then inline,
 *      preserving the model's intent.
 *   3. Multiple sibling `<reasoning>` segments inside a single content
 *      string — each segment becomes its own `reasoning_step` so the
 *      dashboard can render them as ordered steps.
 *
 * Parser contract (returned shape):
 *   - `reasoningSteps[]`: in-order strings, each one trimmed, ready to
 *     pump through `{type:"reasoning_step", text}` events. Empty array
 *     when no reasoning was detected anywhere.
 *   - `cleanedContent`: the content WITH `<reasoning>…</reasoning>`
 *     segments removed (and surrounding whitespace tidied). What the
 *     model would have shown the user if it had no thinking mode.
 *   - `fullReasoning`: the concatenated reasoning trace (`steps.join("\n\n")`),
 *     suitable for `ChatMessage.reasoning` persistence. Null when there
 *     was no reasoning at all (so the DB column stays NULL for the
 *     overwhelming majority of historical-shape turns).
 */

import { describe, it, expect } from "vitest";
import { parseReasoningTrace } from "../services/llm-agent.service.js";

describe("parseReasoningTrace", () => {
  it("returns null fullReasoning + empty steps when content has no reasoning", () => {
    const result = parseReasoningTrace({
      content: "The capital of France is Paris.",
    });
    expect(result.reasoningSteps).toEqual([]);
    expect(result.cleanedContent).toBe("The capital of France is Paris.");
    expect(result.fullReasoning).toBeNull();
  });

  it("extracts a single inline <reasoning>...</reasoning> segment", () => {
    const result = parseReasoningTrace({
      content:
        "<reasoning>User asked about France. Capital is Paris.</reasoning>The capital is Paris.",
    });
    expect(result.reasoningSteps).toEqual([
      "User asked about France. Capital is Paris.",
    ]);
    expect(result.cleanedContent).toBe("The capital is Paris.");
    expect(result.fullReasoning).toBe("User asked about France. Capital is Paris.");
  });

  it("extracts multiple sibling <reasoning> segments in arrival order", () => {
    const result = parseReasoningTrace({
      content:
        "<reasoning>Step 1: parse the question.</reasoning>" +
        "<reasoning>Step 2: recall French geography.</reasoning>" +
        "<reasoning>Step 3: pick the answer.</reasoning>" +
        "Paris is the capital.",
    });
    expect(result.reasoningSteps).toEqual([
      "Step 1: parse the question.",
      "Step 2: recall French geography.",
      "Step 3: pick the answer.",
    ]);
    expect(result.cleanedContent).toBe("Paris is the capital.");
    expect(result.fullReasoning).toBe(
      "Step 1: parse the question.\n\nStep 2: recall French geography.\n\nStep 3: pick the answer.",
    );
  });

  it("handles reasoning segments interleaved between text fragments", () => {
    const result = parseReasoningTrace({
      content:
        "Let me think. <reasoning>The user wants the capital.</reasoning>" +
        " The answer is <reasoning>It's Paris, confirmed.</reasoning>Paris.",
    });
    expect(result.reasoningSteps).toEqual([
      "The user wants the capital.",
      "It's Paris, confirmed.",
    ]);
    // Surrounding whitespace is tidied to a single space so the
    // cleaned content reads naturally without the bracketed segments.
    expect(result.cleanedContent).toBe("Let me think. The answer is Paris.");
  });

  it("treats a provider-native reasoning string as a single step", () => {
    const result = parseReasoningTrace({
      content: "Paris.",
      providerReasoning: "The user asked for the capital of France.",
    });
    expect(result.reasoningSteps).toEqual([
      "The user asked for the capital of France.",
    ]);
    expect(result.cleanedContent).toBe("Paris.");
    expect(result.fullReasoning).toBe(
      "The user asked for the capital of France.",
    );
  });

  it("concatenates provider-native reasoning BEFORE inline segments", () => {
    const result = parseReasoningTrace({
      content:
        "<reasoning>Inline step.</reasoning>The answer is Paris.",
      providerReasoning: "Provider native reasoning.",
    });
    expect(result.reasoningSteps).toEqual([
      "Provider native reasoning.",
      "Inline step.",
    ]);
    expect(result.cleanedContent).toBe("The answer is Paris.");
    expect(result.fullReasoning).toBe(
      "Provider native reasoning.\n\nInline step.",
    );
  });

  it("ignores empty / whitespace-only reasoning segments", () => {
    const result = parseReasoningTrace({
      content:
        "<reasoning>   </reasoning>" +
        "<reasoning>real step</reasoning>" +
        "<reasoning></reasoning>" +
        "answer",
    });
    expect(result.reasoningSteps).toEqual(["real step"]);
    expect(result.cleanedContent).toBe("answer");
  });

  it("handles unclosed <reasoning> tag by treating the remainder as one step", () => {
    // Defensive: a model that emits an opening tag and then never closes
    // it (truncation, mid-stream abort) should still produce a step
    // instead of leaking the raw tag into the user-visible content.
    const result = parseReasoningTrace({
      content: "<reasoning>truncated thought without a close",
    });
    expect(result.reasoningSteps).toEqual([
      "truncated thought without a close",
    ]);
    expect(result.cleanedContent).toBe("");
  });

  it("preserves multi-line reasoning content with internal newlines", () => {
    const result = parseReasoningTrace({
      content:
        "<reasoning>Line one of the thought.\nLine two of the thought.</reasoning>The answer.",
    });
    expect(result.reasoningSteps).toEqual([
      "Line one of the thought.\nLine two of the thought.",
    ]);
    expect(result.cleanedContent).toBe("The answer.");
  });

  it("handles a null content with only providerReasoning set", () => {
    // Tool-only iteration: assistant content is null but the provider
    // surfaced a reasoning trace separately. We should still produce a
    // step + null cleanedContent (callers know to skip the text emit).
    const result = parseReasoningTrace({
      content: null,
      providerReasoning: "Decided to call list_files.",
    });
    expect(result.reasoningSteps).toEqual([
      "Decided to call list_files.",
    ]);
    expect(result.cleanedContent).toBe("");
    expect(result.fullReasoning).toBe("Decided to call list_files.");
  });

  // Regression — WARP-458 R2.
  // The parser runs unconditionally on every assistant chunk per AC4,
  // so it must NOT damage content that has no reasoning tags. Earlier
  // implementations used `\s+ → " "` as a catch-all whitespace tidy
  // which silently collapsed every paragraph break in every chat reply.
  it("preserves paragraph breaks in content with no reasoning tags", () => {
    const result = parseReasoningTrace({
      content: "Para one.\n\nPara two.",
    });
    expect(result.cleanedContent).toBe("Para one.\n\nPara two.");
    expect(result.reasoningSteps).toEqual([]);
    expect(result.fullReasoning).toBeNull();
  });

  it("preserves paragraph breaks in cleanedContent after extracting reasoning", () => {
    const result = parseReasoningTrace({
      content: "Hello.\n\n<reasoning>step</reasoning>\n\nGoodbye.",
    });
    expect(result.cleanedContent).toBe("Hello.\n\nGoodbye.");
    expect(result.reasoningSteps).toEqual(["step"]);
  });

  // Regression — WARP-458 R1.
  // Locks in the current non-greedy regex behavior so any future tweak
  // to the `<reasoning>…</reasoning>` matcher surfaces here in CI. The
  // outer opener pairs with the FIRST `</reasoning>`, so the inner
  // opener becomes part of the captured step content.
  it("treats inner reasoning opener as content when wrapped by outer reasoning tags (regex non-greedy)", () => {
    const result = parseReasoningTrace({
      content: "<reasoning>unclosed <reasoning>closed</reasoning>after",
    });
    expect(result.reasoningSteps).toEqual(["unclosed <reasoning>closed"]);
    expect(result.cleanedContent).toBe("after");
  });
});
