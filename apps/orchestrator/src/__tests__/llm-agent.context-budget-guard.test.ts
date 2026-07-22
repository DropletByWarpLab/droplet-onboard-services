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
import {
  OUTPUT_RESERVE,
  ITERATION_MIN_HEADROOM,
} from "../services/prompt-budget.consts.js";

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

  it("large tool schemas do not trip the guard (schemas are excluded from the estimate)", async () => {
    // A single advertised tool with a deliberately huge inputSchema (~60k
    // chars) — if the guard still folded serialized schemas into its
    // estimate (the pre-fix bug), this alone would blow the 16k-window
    // threshold and finalize on iteration 1. The transcript itself (small
    // tool result) stays tiny, so the guard must NOT fire.
    const bigSchema = {
      type: "object",
      properties: {
        query: { type: "string", description: "x".repeat(60000) },
      },
    };
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
    const queue = [toolCallMsg, answerMsg];
    const chat = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        choices: [
          { message: queue[Math.min(chat.mock.calls.length - 1, queue.length - 1)] },
        ],
      }),
    }));
    const agentDeps: AgentDeps = {
      mcp: {
        listTools: vi
          .fn()
          .mockResolvedValue([
            { name: "search_content", description: "d", inputSchema: bigSchema },
          ]),
        callTool: vi.fn().mockResolvedValue({
          isError: false,
          content: [{ type: "text", text: "x".repeat(100) }],
        }),
      } as never,
      aiGateway: { chat } as never,
    };

    const result = await runAgent(agentDeps, {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      context_window: 16384,
    });

    expect(result.stop_reason).toBe("model_done");
    const secondReq = chat.mock.calls[1]![0] as {
      tools: { function: { name: string } }[];
    };
    expect(secondReq.tools.map((t) => t.function.name)).toContain(
      "search_content",
    );
  });

  it("boundary: fires strictly-greater-than the threshold, not at it (spec §2 arithmetic)", async () => {
    // window − OUTPUT_RESERVE − ITERATION_MIN_HEADROOM, in tokens.
    const window = 4096;
    const threshold = window - OUTPUT_RESERVE - ITERATION_MIN_HEADROOM;
    // Math.ceil(chars/4) === threshold exactly when chars === threshold*4
    // (any of the 4 chars below it also ceils to threshold, but the exact
    // multiple is the simplest to reason about for the "+4 flips it" step).
    const targetChars = threshold * 4;

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
    const toolResultText = "y".repeat(50);
    const toolResultMsg = {
      role: "tool",
      tool_call_id: "c1",
      content: toolResultText,
    };
    const answerMsg = { role: "assistant", content: "final answer" };

    // Computed dynamically: measure the exact JSON size the guard will see
    // (the assistant tool-call message + the tool result the loop pushes)
    // with an empty user message, then pad the user content with safe
    // (unescaped) ASCII so the total lands exactly on `targetChars`.
    const zeroLen = JSON.stringify([
      { role: "user", content: "" },
      toolCallMsg,
      toolResultMsg,
    ]).length;
    const pad = targetChars - zeroLen;
    expect(pad).toBeGreaterThan(0);

    function makeDeps() {
      const queue = [toolCallMsg, answerMsg];
      const chat = vi.fn().mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          choices: [
            { message: queue[Math.min(chat.mock.calls.length - 1, queue.length - 1)] },
          ],
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
            content: [{ type: "text", text: toolResultText }],
          }),
        } as never,
        aiGateway: { chat } as never,
      };
      return { agentDeps, chat };
    }

    // AT the threshold — Math.ceil(chars/4) === threshold; the condition is
    // strictly `>`, so the guard must NOT fire.
    const { agentDeps: atDeps, chat: atChat } = makeDeps();
    const atResult = await runAgent(atDeps, {
      model: "m",
      messages: [{ role: "user", content: "a".repeat(pad) }],
      context_window: window,
    });
    expect(atResult.stop_reason).toBe("model_done");
    expect(atChat).toHaveBeenCalledTimes(2);
    expect(
      (atChat.mock.calls[1]![0] as { tools: unknown[] }).tools.length,
    ).toBeGreaterThan(0);

    // One 4-char pad over — Math.ceil(chars/4) === threshold + 1 — must fire.
    const { agentDeps: overDeps, chat: overChat } = makeDeps();
    const overResult = await runAgent(overDeps, {
      model: "m",
      messages: [{ role: "user", content: "a".repeat(pad + 4) }],
      context_window: window,
    });
    expect(overResult.stop_reason).toBe("context_budget");
    expect(overChat).toHaveBeenCalledTimes(2);
    const overSecondReq = overChat.mock.calls[1]![0] as {
      tools: unknown[];
      tool_choice: string;
    };
    expect(overSecondReq.tools).toEqual([]);
    expect(overSecondReq.tool_choice).toBe("none");
  });
});
