/**
 * WARP-1613 — the provider reasoning channel arrives under three different
 * names and we only ever read one of them.
 *
 * Ollama's OpenAI-compat layer emits `reasoning` (see `ollama/openai/openai.go`:
 * `Reasoning string \`json:"reasoning,omitempty"\`` on the delta message, filled
 * from `r.Message.Thinking`). The orchestrator read only `reasoning_content`, a
 * LiteLLM/cloud spelling, so for gpt-oss — our shipped local model — the whole
 * analysis channel arrived under a name nothing looked at and was silently
 * dropped.
 *
 * These tests pin all three spellings plus the absent case. They are unit tests
 * over the extractor rather than stream-level tests because the extractor is the
 * single place the naming decision lives; `llm-agent.streaming.test.ts` covers
 * how a captured trace then flows through the loop.
 */
import { describe, it, expect } from "vitest";
import { providerReasoningOf } from "../services/llm-agent.service";

describe("providerReasoningOf — every spelling the provider fleet uses", () => {
  it("reads Ollama's OpenAI-compat `reasoning` (the one we were missing)", () => {
    expect(providerReasoningOf({ reasoning: "weighing the options" })).toBe(
      "weighing the options"
    );
  });

  it("still reads LiteLLM/cloud `reasoning_content` (WARP-458 behaviour)", () => {
    expect(providerReasoningOf({ reasoning_content: "analysing" })).toBe("analysing");
  });

  it("reads native /api/chat `thinking`, so a transport switch needs no change here", () => {
    expect(providerReasoningOf({ thinking: "considering" })).toBe("considering");
  });

  it("returns falsy when the delta carries no reasoning at all", () => {
    expect(providerReasoningOf({})).toBe("");
    expect(providerReasoningOf({ reasoning: null, reasoning_content: null })).toBe("");
    // An empty string must stay falsy — callers guard on truthiness, and an
    // empty step would otherwise open a reasoning block with nothing in it.
    expect(providerReasoningOf({ reasoning: "" })).toBe("");
  });

  it("takes the FIRST populated spelling and ignores the rest, never concatenating", () => {
    // These are three spellings of ONE channel, never three channels. If two
    // are ever populated they carry the same text, so concatenating would put
    // it on the wire twice and persist a doubled trace the user reads.
    // First-wins degrades to ignoring a duplicate, which is the safe direction.
    expect(
      providerReasoningOf({ reasoning: "a", reasoning_content: "b", thinking: "c" })
    ).toBe("a");
    // The realistic shape of the hazard: the SAME text under two names.
    // Concatenating turned this into "weighing itweighing it".
    expect(
      providerReasoningOf({ reasoning: "weighing it", reasoning_content: "weighing it" })
    ).toBe("weighing it");
    // Order is deliberate: `reasoning` is what Ollama actually sends, so the
    // shipped path never depends on the tie-break at all.
    expect(providerReasoningOf({ reasoning_content: "b", thinking: "c" })).toBe("b");
  });

  it("ignores non-string values rather than coercing them", () => {
    // Defensive: the delta is an unchecked `JSON.parse` cast at the transport
    // seam, so a provider sending a number or object must not become "[object
    // Object]" in a user-visible reasoning trace.
    expect(
      providerReasoningOf({ reasoning: 42 as unknown as string })
    ).toBe("");
    expect(
      providerReasoningOf({ reasoning_content: {} as unknown as string })
    ).toBe("");
  });
});
