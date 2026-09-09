/**
 * WARP-2177 — the agent loop's `checkpoint` port.
 *
 * The one seam the durable-run worker needs from `runAgent()`. Pinned here,
 * separately from the worker, so the contract the worker builds on cannot
 * drift without a loop-side test going red:
 *
 *   1. `onIteration(iter, messages)` fires at the top of EVERY iteration,
 *      before the model call, and `messages` is a complete conversation
 *      (every tool_calls has its tool replies).
 *   2. `beforeToolCall` fires after the guards admit a call and BEFORE
 *      `mcp.callTool`; `afterToolCall` fires after a live dispatch with the
 *      raw wire text.
 *   3. A `beforeToolCall` that answers with a stored result REPLAYS it: the
 *      tool is not dispatched, `afterToolCall` is not called, and the model
 *      sees the replayed text as the tool's reply.
 *   4. A thrown hook aborts the turn (a checkpoint that could not be written
 *      must not let the run continue un-resumable).
 *   5. With no port the loop is byte-for-byte unchanged — same model
 *      requests, same dispatches, same result.
 */
import { describe, it, expect, vi } from "vitest";
import {
  runAgent,
  type AgentCheckpointPort,
  type AgentDeps,
} from "../services/llm-agent.service.js";

const callDatetime = {
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: "c1",
      type: "function",
      function: { name: "get_current_datetime", arguments: "{}" },
    },
  ],
};
const done = { role: "assistant", content: "It is noon." };

function makeDeps(turns: unknown[]) {
  const chat = vi.fn().mockImplementation(async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: turns[Math.min(chat.mock.calls.length - 1, turns.length - 1)] }],
    }),
  }));
  const callTool = vi.fn().mockResolvedValue({
    isError: false,
    content: [{ type: "text", text: '{"iso":"2026-09-04T12:00:00Z"}' }],
  });
  const deps: AgentDeps = {
    mcp: {
      listTools: vi
        .fn()
        .mockResolvedValue([{ name: "get_current_datetime", description: "d", inputSchema: {} }]),
      callTool,
    } as never,
    aiGateway: { chat } as never,
  };
  return { deps, chat, callTool };
}

function recordingPort(replay?: { text: string; isError: boolean }) {
  const events: string[] = [];
  const iterations: Array<{ iter: number; roles: string[] }> = [];
  const port: AgentCheckpointPort = {
    async onIteration(iter, messages) {
      events.push(`iter:${iter}`);
      iterations.push({ iter, roles: messages.map((m) => m.role) });
    },
    async beforeToolCall(call) {
      events.push(`before:${call.tool}@${call.iteration}:${call.tool_call_id}`);
      return replay;
    },
    async afterToolCall(call) {
      events.push(`after:${call.tool}@${call.iteration}:${call.text}`);
    },
  };
  return { port, events, iterations };
}

describe("runAgent — checkpoint port (WARP-2177)", () => {
  it("fires onIteration at the top of every iteration with a complete conversation", async () => {
    const { deps } = makeDeps([callDatetime, done]);
    const { port, events, iterations } = recordingPort();
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "what time is it" }],
      max_iter: 5,
      checkpoint: port,
    });
    expect(result.stop_reason).toBe("model_done");
    expect(events).toEqual([
      "iter:0",
      "before:get_current_datetime@0:c1",
      'after:get_current_datetime@0:{"iso":"2026-09-04T12:00:00Z"}',
      "iter:1",
    ]);
    // Iteration 1's checkpoint carries the assistant tool_calls AND its tool
    // reply — a valid conversation, which is what makes it resumable.
    expect(iterations[0]).toEqual({ iter: 0, roles: ["user"] });
    expect(iterations[1]).toEqual({ iter: 1, roles: ["user", "assistant", "tool"] });
  });

  it("replays a stored result instead of dispatching, and skips afterToolCall", async () => {
    const { deps, chat, callTool } = makeDeps([callDatetime, done]);
    const { port, events } = recordingPort({
      text: '{"iso":"REPLAYED"}',
      isError: false,
    });
    await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "what time is it" }],
      max_iter: 5,
      checkpoint: port,
    });
    expect(callTool).not.toHaveBeenCalled();
    expect(events).toEqual(["iter:0", "before:get_current_datetime@0:c1", "iter:1"]);
    // The model's second request carries the replayed text as the tool reply.
    const second = chat.mock.calls[1]![0] as {
      messages: Array<{ role: string; content: string; tool_call_id?: string }>;
    };
    const toolMsg = second.messages.find((m) => m.role === "tool");
    expect(toolMsg?.tool_call_id).toBe("c1");
    expect(String(toolMsg?.content)).toContain("REPLAYED");
  });

  it("a throwing checkpoint aborts the turn instead of continuing un-resumable", async () => {
    const { deps, chat } = makeDeps([callDatetime, done]);
    const port: AgentCheckpointPort = {
      async onIteration(iter) {
        if (iter === 1) throw new Error("db gone");
      },
      async beforeToolCall() {
        return undefined;
      },
      async afterToolCall() {},
    };
    await expect(
      runAgent(deps, {
        model: "m",
        messages: [{ role: "user", content: "what time is it" }],
        max_iter: 5,
        checkpoint: port,
      }),
    ).rejects.toThrow("db gone");
    // The second model call never happened.
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("without a port the loop is unchanged: same requests, same dispatches, same result", async () => {
    const a = makeDeps([callDatetime, done]);
    const b = makeDeps([callDatetime, done]);
    const { port } = recordingPort();
    const req = {
      model: "m",
      messages: [{ role: "user" as const, content: "what time is it" }],
      max_iter: 5,
    };
    const plain = await runAgent(a.deps, req);
    const hooked = await runAgent(b.deps, { ...req, checkpoint: port });
    expect(a.chat.mock.calls.map((c) => c[0])).toEqual(b.chat.mock.calls.map((c) => c[0]));
    expect(a.callTool.mock.calls).toEqual(b.callTool.mock.calls);
    expect(plain).toEqual(hooked);
  });
});
