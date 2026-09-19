/**
 * WARP-2178 — the loop never runs out of window silently, and every tool
 * result is bounded at the CONFIGURED cap and measured.
 *
 *   1. When the in-loop context guard fires, a structured
 *      `agent_context_budget_reached` warning names the iteration and the
 *      estimate (the same posture as context-budget.service.ts's one warn per
 *      dropped block). The turn still finalises with `context_budget`.
 *   2. `config.AGENT_TOOL_RESULT_CAP_CHARS` reaches the bounding step: with
 *      a 1000-char cap a 3000-char result is shortened, and the
 *      `agent_tool_result_size` debug line records both sizes.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    AGENT_BLANK_TURN_DEBUG: false,
    OLLAMA_CONTEXT_LENGTH: 16384,
    TOOL_SELECTION_MODE: "off",
    AGENT_TOOL_RESULT_CAP_CHARS: 1000,
    agentMaxIter: { defaultIter: 10, capIter: 10 },
  },
}));

interface LoggedLine {
  level: string;
  obj: Record<string, unknown>;
  msg: string;
}
const logged = vi.hoisted(() => [] as LoggedLine[]);
vi.mock("../lib/logger.js", () => {
  const push = (level: string) => (obj: Record<string, unknown>, msg: string) => {
    logged.push({ level, obj, msg });
  };
  const stub = {
    warn: push("warn"),
    debug: push("debug"),
    info: push("info"),
    error: push("error"),
    trace: push("trace"),
    fatal: push("fatal"),
    silent: () => {},
    child: () => stub,
  };
  return { createLogger: () => stub };
});

import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";

const bigCall = (id: string) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: `{"path":"/${id}"}` } }],
});

function makeDeps(resultChars: number) {
  const chat = vi.fn(async (req: { messages: Array<{ role: string }> }) => {
    const n = req.messages.filter((m) => m.role === "tool").length;
    const message = n < 6 ? bigCall(`c${n}`) : { role: "assistant", content: "done" };
    return { ok: true, json: async () => ({ choices: [{ message }] }) };
  });
  const callTool = vi.fn(async () => ({
    isError: false,
    content: [{ type: "text", text: JSON.stringify({ content: "z".repeat(resultChars) }) }],
  }));
  const deps: AgentDeps = {
    mcp: {
      listTools: vi.fn().mockResolvedValue([{ name: "read_file", description: "d", inputSchema: {} }]),
      callTool,
    } as never,
    aiGateway: { chat } as never,
  };
  return { deps, chat, callTool };
}

describe("WARP-2178 — context guard warns, cap is configured", () => {
  it("emits agent_context_budget_reached naming the iteration and the estimate", async () => {
    logged.length = 0;
    const { deps } = makeDeps(3_000);
    // A tiny window: the guard trips on the second iteration.
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "go" }],
      max_iter: 10,
      context_window: 3_000,
    });
    expect(result.stop_reason).toBe("context_budget");
    const warn = logged.find((l) => l.msg === "agent_context_budget_reached");
    expect(warn).toBeTruthy();
    expect(warn!.level).toBe("warn");
    expect(typeof warn!.obj.iter).toBe("number");
    expect((warn!.obj.iter as number) > 0).toBe(true);
    expect(typeof warn!.obj.estimated_tokens).toBe("number");
    expect((warn!.obj.estimated_tokens as number) > (warn!.obj.threshold_tokens as number)).toBe(true);
    expect(warn!.obj.context_window).toBe(3_000);
  });

  it("bounds every result at config.AGENT_TOOL_RESULT_CAP_CHARS and records both sizes", async () => {
    logged.length = 0;
    const { deps, chat } = makeDeps(3_000);
    await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "go" }],
      max_iter: 2,
    });
    const second = chat.mock.calls[1]![0] as { messages: Array<{ role: string; content: string }> };
    const toolMsg = second.messages.find((m) => m.role === "tool")!;
    expect(toolMsg.content.length).toBeLessThanOrEqual(1000);
    const size = logged.find((l) => l.msg === "agent_tool_result_size");
    expect(size).toBeTruthy();
    expect(size!.level).toBe("debug");
    expect(size!.obj).toMatchObject({ tool: "read_file", reduced: true });
    expect((size!.obj.result_chars as number) > 3_000).toBe(true);
    expect((size!.obj.bounded_chars as number) <= 1000).toBe(true);
  });
});
