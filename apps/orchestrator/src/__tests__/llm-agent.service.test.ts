import { describe, it, expect, vi } from "vitest";
import {
  presetForClass,
  runAgent,
  type AgentDeps,
  type EnhancementDeps,
} from "../services/llm-agent.service.js";
import type { SSEEvent } from "../types/sse-events.js";

describe("runAgent", () => {
  it("emits content_delta then done when model returns content immediately", async () => {
    const events: SSEEvent[] = [];
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([
          { name: "list_files", description: "...", inputSchema: { type: "object", properties: {} } },
        ]),
        callTool: vi.fn(),
      } as never,
      aiGateway: {
        chat: vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            choices: [{ message: { role: "assistant", content: "hello" } }],
          }),
        }),
      } as never,
      onEvent: (e: SSEEvent) => events.push(e),
    };
    const result = await runAgent(deps, {
      model: "ollama/qwen3",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.stop_reason).toBe("model_done");
    expect(result.message.content).toBe("hello");
    expect(events.find((e) => e.type === "content_delta")).toBeDefined();
    expect(events.find((e) => e.type === "done")).toBeDefined();
  });

  it("dispatches tool_calls and feeds results back", async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ devices: [] }) }],
        isError: false,
      });
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
                    id: "c1",
                    type: "function",
                    function: { name: "list_network_devices", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "no devices" } }],
        }),
      });
    const events: SSEEvent[] = [];
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([
          {
            name: "list_network_devices",
            description: "...",
            inputSchema: { type: "object", properties: {} },
          },
        ]),
        callTool,
      } as never,
      aiGateway: { chat } as never,
      onEvent: (e: SSEEvent) => events.push(e),
    };
    const result = await runAgent(deps, {
      model: "ollama/qwen3",
      messages: [{ role: "user", content: "show devices" }],
    });
    // Third arg is the per-call toolCallContext (added in WARP-104
    // follow-up to plumb ncToken through to file handlers); undefined
    // here because the test request didn't pass one.
    expect(callTool).toHaveBeenCalledWith("list_network_devices", {}, undefined);
    expect(result.iterations).toBe(2);
    expect(result.stop_reason).toBe("model_done");
    expect(events.filter((e) => e.type === "tool_call").length).toBe(1);
    expect(events.filter((e) => e.type === "tool_result").length).toBe(1);
    // The trace records the parsed result, not the raw text envelope.
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0].tool).toBe("list_network_devices");
    expect(result.trace[0].tool_call_id).toBe("c1");
  });

  it("surfaces confirmation_required as a non-error tool_result", async () => {
    const callTool = vi.fn().mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "confirmation_required",
            error: { code: "CONFIRMATION_REQUIRED", message: "Open the dashboard to approve" },
          }),
        },
      ],
      isError: false,
    });
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
                    id: "c1",
                    type: "function",
                    function: {
                      name: "block_network_device",
                      arguments: '{"mac":"AA:BB:CC:DD:EE:FF"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            { message: { role: "assistant", content: "Please confirm in the dashboard." } },
          ],
        }),
      });
    const events: SSEEvent[] = [];
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([
          {
            name: "block_network_device",
            description: "...",
            inputSchema: { type: "object", properties: { mac: { type: "string" } } },
          },
        ]),
        callTool,
      } as never,
      aiGateway: { chat } as never,
      onEvent: (e: SSEEvent) => events.push(e),
    };
    const result = await runAgent(deps, {
      model: "ollama/qwen3",
      messages: [{ role: "user", content: "block the router" }],
    });
    expect(result.stop_reason).toBe("model_done");
    const toolResultEvt = events.find((e) => e.type === "tool_result");
    expect(toolResultEvt).toBeDefined();
    if (toolResultEvt && toolResultEvt.type === "tool_result") {
      expect(toolResultEvt.ok).toBe(true);
      expect(toolResultEvt.status).toBe("confirmation_required");
      expect(toolResultEvt.message).toBe("Open the dashboard to approve");
    }
  });

  it("returns error stop_reason when the ai-gateway responds non-OK", async () => {
    const events: SSEEvent[] = [];
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([]),
        callTool: vi.fn(),
      } as never,
      aiGateway: {
        chat: vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) }),
      } as never,
      onEvent: (e: SSEEvent) => events.push(e),
    };
    const result = await runAgent(deps, {
      model: "ollama/qwen3",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.stop_reason).toBe("error");
    expect(result.error).toContain("502");
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    if (done && done.type === "done") expect(done.stop_reason).toBe("error");
  });

  // WARP-104 reviewer follow-up: verify the per-call session context
  // (ncToken) is plumbed verbatim through every callTool invocation.
  it("forwards req.toolCallContext to mcp.callTool on every dispatch", async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ entries: [] }) }],
        isError: false,
      });
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
                    id: "c-files",
                    type: "function",
                    function: { name: "list_files", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "no files" } }],
        }),
      });
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([
          {
            name: "list_files",
            description: "...",
            inputSchema: { type: "object", properties: {} },
          },
        ]),
        callTool,
      } as never,
      aiGateway: { chat } as never,
    };
    await runAgent(deps, {
      model: "ollama/qwen3",
      messages: [{ role: "user", content: "list my files" }],
      toolCallContext: { ncToken: "nct-from-route" },
    });
    expect(callTool).toHaveBeenCalledWith("list_files", {}, {
      ncToken: "nct-from-route",
    });
  });

  it("tool_choice='none' sends ZERO tools and tool_choice='none' to ai-gateway", async () => {
    const chat = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "it's 11 pm" } }],
      }),
    });
    const listTools = vi.fn().mockResolvedValue([
      { name: "list_cameras", description: "...", inputSchema: { type: "object", properties: {} } },
      { name: "get_system_health", description: "...", inputSchema: { type: "object", properties: {} } },
    ]);
    const deps: AgentDeps = {
      mcp: { listTools, callTool: vi.fn() } as never,
      aiGateway: { chat } as never,
    };
    await runAgent(deps, {
      model: "ollama/qwen3",
      messages: [{ role: "user", content: "what time is it" }],
      tool_choice: "none",
    });
    // The model received an empty tools array (defense-in-depth) AND
    // tool_choice="none" (so the upstream / Ollama-format adapter also
    // sees the explicit suppression).
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][0]).toMatchObject({
      tools: [],
      tool_choice: "none",
    });
    // listTools is short-circuited to avoid the MCP round-trip when
    // we already know the model can't see them.
    expect(listTools).not.toHaveBeenCalled();
  });

  it("tool_choice defaults to 'auto' and forwards the full tool set when unset", async () => {
    const chat = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "done" } }],
      }),
    });
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([
          { name: "list_cameras", description: "...", inputSchema: { type: "object", properties: {} } },
        ]),
        callTool: vi.fn(),
      } as never,
      aiGateway: { chat } as never,
    };
    await runAgent(deps, {
      model: "ollama/qwen3",
      messages: [{ role: "user", content: "list cameras" }],
      // tool_choice intentionally omitted
    });
    expect(chat.mock.calls[0][0]).toMatchObject({ tool_choice: "auto" });
    expect((chat.mock.calls[0][0] as { tools: unknown[] }).tools).toHaveLength(1);
  });
});

describe("presetForClass (WARP-437)", () => {
  it("factual → rerankCandidates=100, no enhance", () => {
    const p = presetForClass("factual");
    expect(p.enhance).toBeUndefined();
    expect(p.searchOverrides?.rerankCandidates).toBe(100);
  });

  it("analytical → multiQuery=true with n=3", () => {
    const p = presetForClass("analytical");
    expect(p.enhance?.multiQuery).toBe(true);
    expect(p.enhance?.n).toBe(3);
    expect(p.searchOverrides?.rerankCandidates).toBe(80);
  });

  it("conversational → minSimilarity=0.5, perArmK=50, no enhance", () => {
    const p = presetForClass("conversational");
    expect(p.searchOverrides?.minSimilarity).toBe(0.5);
    expect(p.searchOverrides?.perArmK).toBe(50);
    expect(p.enhance).toBeUndefined();
  });

  it("navigational extracts filename-shaped token", () => {
    const p = presetForClass("navigational", "open camera-1 settings");
    expect(p.filenameContains).toBe("camera-1");
  });

  it("navigational with no filename token returns empty preset", () => {
    const p = presetForClass("navigational", "go");
    expect(p).toEqual({});
  });

  it("unknown → no overrides", () => {
    const p = presetForClass("unknown");
    expect(p).toEqual({});
  });
});

describe("runAgent with EnhancementDeps (WARP-437)", () => {
  // Shared helper: build a deps bundle that captures the toolCallContext
  // each `callTool` receives so tests can assert on the `_enhancement`
  // bundle the agent loop computed pre-dispatch.
  function buildDeps(opts: {
    enhancement: EnhancementDeps;
    toolCallArgs: string;
    finalContent?: string;
  }): {
    deps: AgentDeps;
    callTool: ReturnType<typeof vi.fn>;
    chat: ReturnType<typeof vi.fn>;
  } {
    const callTool = vi.fn().mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({ hits: [] }),
        },
      ],
      isError: false,
    });
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
                    id: "c-search",
                    type: "function",
                    function: {
                      name: "search_content",
                      arguments: opts.toolCallArgs,
                    },
                  },
                ],
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: opts.finalContent ?? "done",
              },
            },
          ],
        }),
      });
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([
          {
            name: "search_content",
            description: "...",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
            },
          },
        ]),
        callTool,
      } as never,
      aiGateway: { chat } as never,
      enhancement: opts.enhancement,
    };
    return { deps, callTool, chat };
  }

  it("happy path: classifies analytical → multiQuery preset attaches extraQueryVectors + searchOverrides", async () => {
    const classify = vi
      .fn()
      .mockResolvedValue({ cls: "analytical", confidence: 0.85 });
    const hyde = vi.fn().mockResolvedValue("a passage");
    const multiQuery = vi
      .fn()
      .mockResolvedValue(["q1", "q2", "q3"]);
    const embed = vi.fn().mockResolvedValue([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    const enhancement: EnhancementDeps = {
      classify,
      hyde,
      multiQuery,
      embed,
    };
    const { deps, callTool } = buildDeps({
      enhancement,
      toolCallArgs: JSON.stringify({ query: "compare X vs Y" }),
    });

    await runAgent(deps, {
      model: "ollama/qwen3",
      messages: [{ role: "user", content: "compare X vs Y" }],
    });

    // classify saw the raw query; multiQuery ran; hyde did NOT (analytical
    // preset is multiQuery-only); embed ran once with the 3 rewrites.
    expect(classify).toHaveBeenCalledWith("compare X vs Y");
    expect(multiQuery).toHaveBeenCalledTimes(1);
    expect(multiQuery).toHaveBeenCalledWith("compare X vs Y", 3);
    expect(hyde).not.toHaveBeenCalled();
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith(["q1", "q2", "q3"]);

    // callTool received the search args plus a toolCallContext with the
    // computed `_enhancement` bundle. analytical → no hydeVector,
    // extraQueryVectors set to the embed stub output, rerankCandidates=80.
    expect(callTool).toHaveBeenCalledTimes(1);
    const [toolName, toolArgs, toolContext] = callTool.mock.calls[0];
    expect(toolName).toBe("search_content");
    expect(toolArgs).toEqual({ query: "compare X vs Y" });
    expect(toolContext).toBeDefined();
    expect(toolContext._enhancement).toBeDefined();
    expect(toolContext._enhancement.hydeVector).toBeUndefined();
    expect(toolContext._enhancement.extraQueryVectors).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    expect(toolContext._enhancement.searchOverrides?.rerankCandidates).toBe(80);
  });

  it("failure degradation: classifier throws → callTool still dispatches with unchanged toolCallContext", async () => {
    const classify = vi
      .fn()
      .mockRejectedValue(new Error("classifier down"));
    const hyde = vi.fn();
    const multiQuery = vi.fn();
    const embed = vi.fn();
    const enhancement: EnhancementDeps = {
      classify,
      hyde,
      multiQuery,
      embed,
    };
    const { deps, callTool } = buildDeps({
      enhancement,
      toolCallArgs: JSON.stringify({ query: "anything" }),
    });

    const result = await runAgent(deps, {
      model: "ollama/qwen3",
      messages: [{ role: "user", content: "anything" }],
      toolCallContext: { ncToken: "nct-base" },
    });

    // The user-facing flow keeps going: callTool was invoked with the
    // request's original toolCallContext, untouched — no `_enhancement`
    // field smuggled in.
    expect(callTool).toHaveBeenCalledTimes(1);
    const [, , toolContext] = callTool.mock.calls[0];
    expect(toolContext).toEqual({ ncToken: "nct-base" });
    expect(toolContext._enhancement).toBeUndefined();
    expect(hyde).not.toHaveBeenCalled();
    expect(multiQuery).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(result.stop_reason).toBe("model_done");
  });

  it("LLM-wins precedence: LLM emits enhance.hyde=true + analytical preset → both HyDE and multi-query run", async () => {
    const classify = vi
      .fn()
      .mockResolvedValue({ cls: "analytical", confidence: 0.85 });
    const hyde = vi.fn().mockResolvedValue("hyde passage");
    const multiQuery = vi
      .fn()
      .mockResolvedValue(["mq1", "mq2", "mq3"]);
    // First call: hyde embedding. Second call: multi-query embeddings.
    const embed = vi
      .fn()
      .mockResolvedValueOnce([[9, 9, 9]])
      .mockResolvedValueOnce([
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]);
    const enhancement: EnhancementDeps = {
      classify,
      hyde,
      multiQuery,
      embed,
    };
    const { deps, callTool } = buildDeps({
      enhancement,
      toolCallArgs: JSON.stringify({
        query: "compare X vs Y",
        enhance: { hyde: true },
      }),
    });

    await runAgent(deps, {
      model: "ollama/qwen3",
      messages: [{ role: "user", content: "compare X vs Y" }],
    });

    // LLM's `hyde: true` wins → HyDE ran. analytical preset still
    // contributes multiQuery: true → multi-query ran. Both vectors land
    // in the _enhancement bundle.
    expect(hyde).toHaveBeenCalledTimes(1);
    expect(multiQuery).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledTimes(2);

    const [, , toolContext] = callTool.mock.calls[0];
    expect(toolContext._enhancement.hydeVector).toEqual([9, 9, 9]);
    expect(toolContext._enhancement.extraQueryVectors).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
  });
});
