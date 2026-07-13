/**
 * WARP-458 — agent-loop emit-ordering tests.
 *
 * AC §3: `{type:"reasoning_step", text}` blocks are emitted BEFORE any
 * `content_delta` ("text") block in the same assistant turn. This file
 * exercises the live `runAgent()` with a fake ai-gateway that returns
 * inline `<reasoning>` segments, and verifies:
 *
 *   1. Reasoning_step events land before content_delta in the event
 *      stream.
 *   2. The content_delta carries the CLEANED text (no leftover
 *      `<reasoning>` tags).
 *   3. Multiple sibling reasoning segments produce one event per step,
 *      in arrival order.
 *   4. `runAgent`'s result.message.reasoning carries the concatenated
 *      trace so the route layer can persist it.
 *   5. The default `captureReasoning=undefined` behaves like
 *      `captureReasoning=true` for backwards compatibility — explicit
 *      `false` is exercised in the flag-coverage test (chunk 4).
 *
 * Persistence smoke is handled in a separate test against
 * chat-persistence + the routes layer; here we only verify the wire
 * shape the agent loop produces.
 */

import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";
import type { SSEEvent } from "../types/sse-events.js";

describe("runAgent — reasoning_step emission", () => {
  it("emits reasoning_step blocks BEFORE content_delta for the same turn", async () => {
    const events: SSEEvent[] = [];
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([]),
        callTool: vi.fn(),
      } as never,
      aiGateway: {
        chat: vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  role: "assistant",
                  content:
                    "<reasoning>The user wants the capital of France.</reasoning>" +
                    "<reasoning>I will respond with Paris.</reasoning>" +
                    "Paris is the capital.",
                },
              },
            ],
          }),
        }),
      } as never,
      onEvent: (e: SSEEvent) => events.push(e),
    };
    const result = await runAgent(deps, {
      model: "ollama/qwen3",
      messages: [{ role: "user", content: "what is the capital of france" }],
      captureReasoning: true,
    });

    // Indices for ordering assertion.
    const firstReasoning = events.findIndex((e) => e.type === "reasoning_step");
    const firstText = events.findIndex((e) => e.type === "content_delta");
    expect(firstReasoning).toBeGreaterThanOrEqual(0);
    expect(firstText).toBeGreaterThanOrEqual(0);
    expect(firstReasoning).toBeLessThan(firstText);

    // Two reasoning_step events, in arrival order.
    const reasoningSteps = events.filter((e) => e.type === "reasoning_step");
    expect(reasoningSteps).toHaveLength(2);
    if (
      reasoningSteps[0].type === "reasoning_step" &&
      reasoningSteps[1].type === "reasoning_step"
    ) {
      expect(reasoningSteps[0].text).toBe(
        "The user wants the capital of France.",
      );
      expect(reasoningSteps[1].text).toBe("I will respond with Paris.");
    }

    // content_delta carries the CLEANED text only.
    const textEvts = events.filter((e) => e.type === "content_delta");
    expect(textEvts).toHaveLength(1);
    if (textEvts[0].type === "content_delta") {
      expect(textEvts[0].text).toBe("Paris is the capital.");
      // No leakage of the raw tags into the user-visible text.
      expect(textEvts[0].text).not.toContain("<reasoning>");
      expect(textEvts[0].text).not.toContain("</reasoning>");
    }

    // AgentResult.message.content is cleaned; assistant.reasoning carries
    // the concatenated trace for ChatMessage.reasoning persistence.
    expect(result.message.content).toBe("Paris is the capital.");
    expect(result.message.reasoning).toBe(
      "The user wants the capital of France.\n\nI will respond with Paris.",
    );
  });

  it("does not emit reasoning_step when the model returns no <reasoning> segments", async () => {
    const events: SSEEvent[] = [];
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([]),
        callTool: vi.fn(),
      } as never,
      aiGateway: {
        chat: vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            choices: [
              { message: { role: "assistant", content: "plain answer" } },
            ],
          }),
        }),
      } as never,
      onEvent: (e: SSEEvent) => events.push(e),
    };
    const result = await runAgent(deps, {
      model: "ollama/qwen3",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(events.filter((e) => e.type === "reasoning_step")).toHaveLength(0);
    expect(events.filter((e) => e.type === "content_delta")).toHaveLength(1);
    expect(result.message.content).toBe("plain answer");
    expect(result.message.reasoning ?? null).toBeNull();
  });

  it("captures a provider-native reasoning field as a step before content_delta", async () => {
    const events: SSEEvent[] = [];
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([]),
        callTool: vi.fn(),
      } as never,
      aiGateway: {
        chat: vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Paris.",
                  // Mirror what LiteLLM surfaces for OpenAI o-series.
                  reasoning_content: "User asked for the capital of France.",
                },
              },
            ],
          }),
        }),
      } as never,
      onEvent: (e: SSEEvent) => events.push(e),
    };
    const result = await runAgent(deps, {
      model: "openai/o1-mini",
      messages: [{ role: "user", content: "capital of france" }],
      captureReasoning: true,
    });
    const reasoningSteps = events.filter((e) => e.type === "reasoning_step");
    expect(reasoningSteps).toHaveLength(1);
    if (reasoningSteps[0].type === "reasoning_step") {
      expect(reasoningSteps[0].text).toBe(
        "User asked for the capital of France.",
      );
    }
    const textEvts = events.filter((e) => e.type === "content_delta");
    expect(textEvts).toHaveLength(1);
    if (textEvts[0].type === "content_delta") {
      expect(textEvts[0].text).toBe("Paris.");
    }
    expect(result.message.reasoning).toBe(
      "User asked for the capital of France.",
    );
    // WARP-495: the raw provider passthrough is stripped from result.message —
    // only our parsed `reasoning` is surfaced, not the duplicate `reasoning_content`.
    expect(result.message).not.toHaveProperty("reasoning_content");
  });
});
