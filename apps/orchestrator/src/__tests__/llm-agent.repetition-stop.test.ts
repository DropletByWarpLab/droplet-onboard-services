/**
 * Spec §4 — repetition early-stop. Occurrence 1 of (name, canonical args)
 * dispatches; occurrence 2 gets a REPEATED_CALL nudge and no dispatch;
 * occurrence 3 triggers the finalization pass (stop_reason "repetition").
 */
import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";

const sameCall = {
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: "c1",
      type: "function",
      function: { name: "search_content", arguments: '{"query":"sophie"}' },
    },
  ],
};

function makeDeps(turns: unknown[]) {
  const chat = vi.fn().mockImplementation(async () => ({
    ok: true,
    json: async () => ({
      choices: [
        { message: turns[Math.min(chat.mock.calls.length - 1, turns.length - 1)] },
      ],
    }),
  }));
  const callTool = vi.fn().mockResolvedValue({
    isError: false,
    content: [{ type: "text", text: '{"hits":[]}' }],
  });
  const deps: AgentDeps = {
    mcp: {
      listTools: vi
        .fn()
        .mockResolvedValue([
          { name: "search_content", description: "d", inputSchema: {} },
        ]),
      callTool,
    } as never,
    aiGateway: { chat } as never,
  };
  return { deps, chat, callTool };
}

describe("runAgent — repetition early-stop (spec §4)", () => {
  it("nudges on the first repeat, finalizes on the second", async () => {
    const { deps, chat, callTool } = makeDeps([
      sameCall, // occ 1: dispatched
      sameCall, // occ 2: nudged
      sameCall, // occ 3: nudged + finalize
      { role: "assistant", content: "here is what I found" },
    ]);
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "find sophie" }],
      max_iter: 10,
    });
    expect(callTool).toHaveBeenCalledTimes(1); // only occurrence 1 dispatched
    const finalReq = chat.mock.calls[3]![0] as {
      tools: unknown[];
      messages: { role: string; content: unknown }[];
    };
    expect(finalReq.tools).toEqual([]); // finalization pass
    expect(
      finalReq.messages.filter((m) =>
        String(m.content).includes("REPEATED_CALL"),
      ).length,
    ).toBe(2);
    expect(result.stop_reason).toBe("repetition");
    expect(result.message.content).toBe("here is what I found");
  });

  it("different args are not repetition", async () => {
    const otherCall = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c2",
          type: "function",
          function: { name: "search_content", arguments: '{"query":"marc"}' },
        },
      ],
    };
    const { deps, callTool } = makeDeps([
      sameCall,
      otherCall,
      { role: "assistant", content: "done" },
    ]);
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "find people" }],
    });
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(result.stop_reason).toBe("model_done");
  });
});
