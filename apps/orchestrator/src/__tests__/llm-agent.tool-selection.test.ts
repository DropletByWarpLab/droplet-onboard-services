/**
 * Spec §3 — selection wired into the loop, plus the self-healing guard: a
 * model call to a REAL pool tool that selection filtered out is answered
 * with TOOL_NOW_AVAILABLE and the tool's domain joins the advertisement for
 * the next iteration — one lost iteration, never a failed turn.
 */
import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";

const POOL_TOOLS = [
  { name: "search_content", description: "d", inputSchema: {} },
  { name: "read_file", description: "d", inputSchema: {} },
  { name: "list_files", description: "d", inputSchema: {} },
  { name: "memory_recall", description: "d", inputSchema: {} },
  { name: "control_device", description: "d", inputSchema: {} },
  { name: "list_network_devices", description: "d", inputSchema: {} },
];

function makeDeps(assistantTurns: unknown[]) {
  const chat = vi.fn().mockImplementation(async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message:
            assistantTurns[
              Math.min(chat.mock.calls.length - 1, assistantTurns.length - 1)
            ],
        },
      ],
    }),
  }));
  const callTool = vi.fn().mockResolvedValue({
    isError: false,
    content: [{ type: "text", text: "{}" }],
  });
  const deps: AgentDeps = {
    mcp: { listTools: vi.fn().mockResolvedValue(POOL_TOOLS), callTool } as never,
    aiGateway: { chat } as never,
  };
  return { deps, chat, callTool };
}

const toolNames = (call: unknown) =>
  (call as { tools: { function: { name: string } }[] }).tools.map(
    (t) => t.function.name,
  );

describe("runAgent — tool selection (spec §3)", () => {
  it("mode unset advertises the full pool (unchanged behavior)", async () => {
    const { deps, chat } = makeDeps([{ role: "assistant", content: "hi" }]);
    await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "turn off the lights" }],
    });
    expect(toolNames(chat.mock.calls[0]![0])).toHaveLength(POOL_TOOLS.length);
  });

  it("domains mode narrows to core + matched domain", async () => {
    const { deps, chat } = makeDeps([{ role: "assistant", content: "done" }]);
    await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "turn off the kitchen lights" }],
      tool_selection_mode: "domains",
    });
    const names = toolNames(chat.mock.calls[0]![0]);
    expect(names).toContain("control_device"); // smart-home rule matched
    expect(names).toContain("search_content"); // core
    expect(names).not.toContain("list_network_devices"); // unmatched domain
  });

  it("self-heals a filtered-but-allowed call and dispatches on retry", async () => {
    const callControl = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "control_device", arguments: "{}" },
        },
      ],
    };
    const { deps, chat, callTool } = makeDeps([
      callControl, // iter 0: filtered → heal
      callControl, // iter 1: now advertised → dispatch
      { role: "assistant", content: "done" },
    ]);
    const result = await runAgent(deps, {
      model: "m",
      // "hello there" matches no rule → core-only advertisement.
      messages: [{ role: "user", content: "hello there" }],
      tool_selection_mode: "domains",
    });
    expect(toolNames(chat.mock.calls[0]![0])).not.toContain("control_device");
    expect(toolNames(chat.mock.calls[1]![0])).toContain("control_device");
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(result.stop_reason).toBe("model_done");
    expect(result.message.content).toBe("done");
  });

  it("a healed-then-dispatched tool is not named as a failing tool on iteration_limit (TOOL_NOW_AVAILABLE exclusion)", async () => {
    const callControl = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "control_device", arguments: "{}" },
        },
      ],
    };
    // maxIter 2: iter 0 heals (no dispatch, TOOL_NOW_AVAILABLE trace entry);
    // iter 1 dispatches successfully but is ALSO the last iteration (the
    // response is still a tool_calls turn, never a plain answer), so the
    // loop exhausts and falls into the WARP-1012 honest-fallback path.
    const { deps, chat, callTool } = makeDeps([callControl, callControl]);
    const result = await runAgent(deps, {
      model: "m",
      // "hello there" matches no rule → core-only advertisement.
      messages: [{ role: "user", content: "hello there" }],
      tool_selection_mode: "domains",
      max_iter: 2,
    });
    expect(toolNames(chat.mock.calls[0]![0])).not.toContain("control_device");
    expect(toolNames(chat.mock.calls[1]![0])).toContain("control_device");
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(result.stop_reason).toBe("iteration_limit");
    // The heal was never a real failure and the real dispatch succeeded —
    // the fallback text must not single out control_device as a failing tool.
    expect(result.message.content).not.toContain("control_device");
  });

  it("selection never resurrects a tool outside allowed_tools", async () => {
    const { deps, chat } = makeDeps([{ role: "assistant", content: "hi" }]);
    await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "turn off the lights" }],
      tool_selection_mode: "domains",
      allowed_tools: ["search_content"], // RBAC-style narrowing wins
    });
    expect(toolNames(chat.mock.calls[0]![0])).toEqual(["search_content"]);
  });

  it("a call outside allowed_tools stays UNKNOWN_TOOL — never self-heals", async () => {
    const callControl = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "control_device", arguments: "{}" },
        },
      ],
    };
    const { deps, chat, callTool } = makeDeps([
      callControl, // iter 0: outside the RBAC-narrowed pool → guard, not heal
      { role: "assistant", content: "done" }, // iter 1: terminate cleanly
    ]);
    const result = await runAgent(deps, {
      model: "m",
      // Matches the "network" domain rule so the run isn't core-only, but
      // control_device (smart-home) is excluded from the pool entirely by
      // allowed_tools — the self-heal ceiling must hold regardless.
      messages: [{ role: "user", content: "check the network devices" }],
      tool_selection_mode: "domains",
      allowed_tools: ["search_content", "list_network_devices"],
    });

    // Never dispatched to MCP.
    expect(callTool).not.toHaveBeenCalled();

    // The tool_result fed back to the model carries UNKNOWN_TOOL, not the
    // self-heal TOOL_NOW_AVAILABLE code.
    const toolReply = messages_(chat.mock.calls[1]![0]).find(
      (m) => m.role === "tool" && m.tool_call_id === "c1",
    ) as { content: string } | undefined;
    expect(toolReply).toBeDefined();
    const parsed = JSON.parse(toolReply!.content);
    expect(parsed.error.code).toBe("UNKNOWN_TOOL");

    // No subsequent chat request ever advertises control_device.
    for (const call of chat.mock.calls) {
      expect(toolNames(call[0])).not.toContain("control_device");
    }
    expect(result.stop_reason).toBe("model_done");
    expect(result.message.content).toBe("done");
  });
});

function messages_(call: unknown) {
  return (call as { messages: { role: string; tool_call_id?: string; content: string }[] })
    .messages;
}
