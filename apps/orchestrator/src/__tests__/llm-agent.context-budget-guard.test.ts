/**
 * Spec §2 — token-aware iteration guard. When the estimated transcript
 * leaves < ITERATION_MIN_HEADROOM under (context_window − OUTPUT_RESERVE),
 * the loop stops dispatching tools and runs ONE finalization pass (zero
 * tools, tool_choice "none", a system nudge) ending stop_reason
 * "context_budget" — never a silent history trim.
 */
import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";
import type { SSEEvent } from "../types/sse-events.js";

/** First call: tool_calls; later calls: scripted content answers. */
function deps(opts: { toolResultChars: number; answers?: unknown[] }) {
  const toolCallMsg = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "c1",
        type: "function",
        function: { name: "search_content", arguments: "{}" },
      },
    ],
  };
  const answerMsg = { role: "assistant", content: "final answer" };
  const queue = [toolCallMsg, ...(opts.answers ?? [answerMsg])];
  const chat = vi.fn().mockImplementation(async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: queue[Math.min(chat.mock.calls.length - 1, queue.length - 1)] }],
    }),
  }));
  const agentDeps: AgentDeps = {
    mcp: {
      listTools: vi
        .fn()
        .mockResolvedValue([
          { name: "search_content", description: "d", inputSchema: {} },
        ]),
      callTool: vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "x".repeat(opts.toolResultChars) }],
      }),
    } as never,
    aiGateway: { chat } as never,
  };
  return { agentDeps, chat };
}

describe("runAgent — context-budget iteration guard (spec §2)", () => {
  it("finalizes with zero tools once headroom is gone", async () => {
    // window 4096 − reserve 1024 − headroom 1536 = 1536 tokens = 6144 chars.
    // One 8000-char tool result blows through that before iteration 2.
    const { agentDeps, chat } = deps({ toolResultChars: 8000 });
    const events: SSEEvent[] = [];
    const result = await runAgent(
      { ...agentDeps, onEvent: (e) => events.push(e) },
      {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        context_window: 4096,
      },
    );
    expect(chat).toHaveBeenCalledTimes(2);
    const finalReq = chat.mock.calls[1]![0] as {
      tools: unknown[];
      tool_choice: string;
      messages: { role: string; content: unknown }[];
    };
    expect(finalReq.tools).toEqual([]);
    expect(finalReq.tool_choice).toBe("none");
    expect(
      finalReq.messages.some(
        (m) =>
          m.role === "system" &&
          String(m.content).includes("Context budget reached"),
      ),
    ).toBe(true);
    expect(result.stop_reason).toBe("context_budget");
    expect(result.message.content).toBe("final answer");
    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({ stop_reason: "context_budget" });
  });

  it("does not fire with a roomy window", async () => {
    const { agentDeps, chat } = deps({ toolResultChars: 100 });
    const result = await runAgent(agentDeps, {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      context_window: 16384,
    });
    expect(result.stop_reason).toBe("model_done");
    const secondReq = chat.mock.calls[1]![0] as { tools: unknown[] };
    expect(secondReq.tools.length).toBeGreaterThan(0);
  });

  it("a finalize pass that still emits tool_calls terminates (no third call)", async () => {
    const toolCallMsg = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c2",
          type: "function",
          function: { name: "search_content", arguments: "{}" },
        },
      ],
    };
    const { agentDeps, chat } = deps({
      toolResultChars: 8000,
      answers: [toolCallMsg],
    });
    const result = await runAgent(agentDeps, {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      context_window: 4096,
    });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.stop_reason).toBe("context_budget");
    expect(result.message.content).toBe(""); // WARP-854 path owns blank turns
  });
});
