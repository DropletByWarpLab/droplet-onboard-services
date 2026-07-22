/**
 * WARP-1479 — blank-answer diagnostics.
 *
 * A terminal turn that produces no visible answer is the suite's largest
 * failure class, and the honest-failure rewrite (routes/llm.ts) makes it
 * VISIBLE but says nothing about WHY the answer was empty. These
 * diagnostics attribute the blank to its layer — the model returned
 * nothing at all, it spent the turn in the reasoning channel, or our own
 * sanitizer demoted the completion — so the follow-up work is aimed at
 * evidence instead of guesses.
 *
 * The raw completion can contain corpus text (file contents the model was
 * quoting), so the bounded `rawExcerpt` is opt-in behind
 * AGENT_BLANK_TURN_DEBUG and everything else is counts-and-labels only.
 */
import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";

/** Gateway that dispatches one real tool, then answers with `finalContent`. */
function depsAnsweringWith(finalContent: unknown, reasoningContent?: string) {
  const chat = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "search_content", arguments: "{}" },
                },
              ],
            },
          },
        ],
      }),
    })
    .mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: "assistant",
              content: finalContent,
              ...(reasoningContent
                ? { reasoning_content: reasoningContent }
                : {}),
            },
          },
        ],
      }),
    });
  const deps: AgentDeps = {
    mcp: {
      listTools: vi
        .fn()
        .mockResolvedValue([
          { name: "search_content", description: "d", inputSchema: {} },
        ]),
      callTool: vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: '{"results":[{"path":"/a.csv"}]}' }],
      }),
    } as never,
    aiGateway: { chat } as never,
  };
  return deps;
}

const REQ = {
  model: "gpt-oss:20b",
  messages: [{ role: "user" as const, content: "how much did I spend?" }],
};

describe("runAgent — blank-answer diagnostics (WARP-1479)", () => {
  it("attributes an empty completion after successful tool work", async () => {
    const result = await runAgent(depsAnsweringWith(""), REQ);

    expect(result.stop_reason).toBe("model_done");
    expect(result.message.content).toBe("");
    expect(result.blankDiagnostics).toMatchObject({
      cause: "model_returned_nothing",
      rawContentChars: 0,
      visibleChars: 0,
      toolCalls: 1,
    });
    // Opt-in only: no corpus text leaves the process by default.
    expect(result.blankDiagnostics?.rawExcerpt).toBeUndefined();
  });

  it("distinguishes a reasoning-only turn from an empty one", async () => {
    const result = await runAgent(
      depsAnsweringWith("", "The user asked about spend; I should total it."),
      REQ,
    );

    expect(result.blankDiagnostics).toMatchObject({ cause: "reasoning_only" });
    expect(result.blankDiagnostics!.providerReasoningChars).toBeGreaterThan(0);
  });

  it("attributes a bare-JSON answer to our own sanitizer, not the model", async () => {
    const result = await runAgent(
      depsAnsweringWith('{"query":"expenses","limit":10}'),
      REQ,
    );

    expect(result.message.content).toBe("");
    expect(result.blankDiagnostics).toMatchObject({
      cause: "sanitizer_demoted_json",
    });
    expect(result.blankDiagnostics!.rawContentChars).toBeGreaterThan(0);
  });

  it("attributes a citation-token-only answer to the sanitizer's strip pass", async () => {
    const result = await runAgent(depsAnsweringWith("【3†source=a.csv】"), REQ);

    expect(result.message.content).toBe("");
    expect(result.blankDiagnostics).toMatchObject({
      cause: "sanitizer_stripped_all",
    });
  });

  it("attaches nothing when the turn produced a real answer", async () => {
    const result = await runAgent(
      depsAnsweringWith("You spent €1,416 last month."),
      REQ,
    );

    expect(result.message.content).toContain("€1,416");
    expect(result.blankDiagnostics).toBeUndefined();
  });
});

describe("runAgent — blank-answer raw excerpt (opt-in)", () => {
  it("includes a bounded rawExcerpt when AGENT_BLANK_TURN_DEBUG is on", async () => {
    vi.resetModules();
    vi.doMock("../config.js", async (importOriginal) => {
      const mod = await importOriginal<typeof import("../config.js")>();
      return {
        ...mod,
        config: { ...mod.config, AGENT_BLANK_TURN_DEBUG: true },
      };
    });
    const { runAgent: runWithDebug } = await import(
      "../services/llm-agent.service.js"
    );

    const raw = "【x】".repeat(400); // sanitizes to "", 1200 chars raw
    const result = await runWithDebug(depsAnsweringWith(raw), REQ);

    expect(result.blankDiagnostics?.cause).toBe("sanitizer_stripped_all");
    expect(result.blankDiagnostics?.rawExcerpt).toBeTruthy();
    expect(result.blankDiagnostics!.rawExcerpt!.length).toBeLessThanOrEqual(500);

    vi.doUnmock("../config.js");
    vi.resetModules();
  });
});
