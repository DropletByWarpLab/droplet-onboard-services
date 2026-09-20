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
      // Firewall-style confirmation carries no re-issue token → display-only chip.
      expect(toolResultEvt.confirmation).toBeUndefined();
    }
  });

  it("forwards a re-issue confirmation token into the tool_result (run_scene → WARP-640)", async () => {
    const callTool = vi.fn().mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "confirmation_required",
            error: {
              code: "CONFIRMATION_REQUIRED",
              message: 'Running "Movie night" needs approval.',
              details: {
                type: "scene_run",
                sceneId: "scene-9",
                confirmationToken: "tok-xyz",
              },
            },
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
                    function: { name: "run_scene", arguments: '{"scene":"Movie night"}' },
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
            { message: { role: "assistant", content: "Approve it in the chip." } },
          ],
        }),
      });
    const events: SSEEvent[] = [];
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([
          {
            name: "run_scene",
            description: "...",
            inputSchema: { type: "object", properties: { scene: { type: "string" } } },
          },
        ]),
        callTool,
      } as never,
      aiGateway: { chat } as never,
      onEvent: (e: SSEEvent) => events.push(e),
    };
    await runAgent(deps, {
      model: "ollama/qwen3",
      messages: [{ role: "user", content: "run movie night" }],
    });
    const evt = events.find((e) => e.type === "tool_result");
    expect(
      evt && evt.type === "tool_result" ? evt.confirmation : undefined,
    ).toEqual({
      kind: "scene_run",
      sceneId: "scene-9",
      confirmationToken: "tok-xyz",
    });
  });

  // ORCH-05 — a thrown tool dispatch must not abort the turn. The loop
  // should feed a structured error back to the model and continue so the
  // model can recover or finalize.
  it("does not kill the turn when a tool dispatch throws", async () => {
    const callTool = vi
      .fn()
      .mockRejectedValueOnce(new Error("stdio pipe closed"));
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
          choices: [
            { message: { role: "assistant", content: "sorry, that tool failed" } },
          ],
        }),
      });
    const events: SSEEvent[] = [];
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([
          { name: "list_files", description: "...", inputSchema: { type: "object", properties: {} } },
        ]),
        callTool,
      } as never,
      aiGateway: { chat } as never,
      onEvent: (e: SSEEvent) => events.push(e),
    };
    const result = await runAgent(deps, {
      model: "ollama/qwen3",
      messages: [{ role: "user", content: "list my files" }],
    });

    // The turn completed normally — the throw did NOT reject runAgent.
    expect(result.stop_reason).toBe("model_done");
    expect(result.message.content).toBe("sorry, that tool failed");
    // The failing dispatch surfaced as a non-OK tool_result chip.
    const toolResultEvt = events.find((e) => e.type === "tool_result");
    expect(toolResultEvt).toBeDefined();
    if (toolResultEvt && toolResultEvt.type === "tool_result") {
      expect(toolResultEvt.ok).toBe(false);
    }
    // The structured error was recorded in the trace and fed back to the
    // model (a second ai-gateway turn happened).
    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0].result).toMatchObject({
      error: "tool_dispatch_failed",
      tool: "list_files",
    });
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

  // WARP-642 — hallucinated tool-name guard. When the model invents a
  // tool name that wasn't advertised (e.g. gpt-oss:20b guessing
  // `knowledge_base_search` instead of the real `search_content`), the
  // agent loop must NOT round-trip it to the MCP child. Instead it feeds
  // back an UNKNOWN_TOOL error that lists the available tools so the model
  // can self-correct on the next iteration.
  it("intercepts an unadvertised tool name and feeds back the valid-tool list", async () => {
    const callTool = vi.fn().mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ data: { results: [] } }) }],
      isError: false,
    });
    const chat = vi
      .fn()
      // 1st turn: model hallucinates `knowledge_base_search`.
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
                    id: "c-bad",
                    type: "function",
                    function: {
                      name: "knowledge_base_search",
                      arguments: JSON.stringify({ query: "vacation policy" }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      })
      // 2nd turn: model self-corrects to the real `search_content`.
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
                    id: "c-good",
                    type: "function",
                    function: {
                      name: "search_content",
                      arguments: JSON.stringify({ query: "vacation policy" }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      })
      // 3rd turn: model answers.
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "Here is what I found." } }],
        }),
      });
    const events: SSEEvent[] = [];
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([
          {
            name: "search_content",
            description: "Hybrid search over docs + brain items.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
            },
          },
        ]),
        callTool,
      } as never,
      aiGateway: { chat } as never,
      onEvent: (e: SSEEvent) => events.push(e),
    };
    const result = await runAgent(deps, {
      model: "ollama/gpt-oss:20b",
      messages: [{ role: "user", content: "search the knowledge base for vacation policy" }],
    });

    // The hallucinated name was NEVER dispatched to the MCP child; only the
    // corrected `search_content` call reached it.
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool.mock.calls[0][0]).toBe("search_content");

    // FINDING 2 — no misleading tool_call chip is rendered for the
    // guard-rejected hallucinated name (the tool_call event must fire only
    // for calls that pass the guard and actually dispatch).
    expect(
      events.find(
        (e) => e.type === "tool_call" && e.name === "knowledge_base_search",
      ),
    ).toBeUndefined();

    // A tool_result with ok=false was emitted for the bad call, carrying the
    // UNKNOWN_TOOL code and the valid-tool list so the model can recover.
    const badResult = events.find(
      (e) => e.type === "tool_result" && e.id === "c-bad",
    );
    expect(badResult).toBeDefined();
    if (badResult && badResult.type === "tool_result") {
      expect(badResult.ok).toBe(false);
      const data = badResult.data as { error?: { code?: string; message?: string } };
      expect(data.error?.code).toBe("UNKNOWN_TOOL");
      expect(data.error?.message).toContain("search_content");
    }

    // FINDING 4 — the role="tool" recovery message MUST actually be
    // delivered to the model's next chat() call, carrying the bad call's
    // tool_call_id so the OpenAI protocol pairs it with the assistant turn.
    expect(chat.mock.calls[1][0].messages).toContainEqual(
      expect.objectContaining({ role: "tool", tool_call_id: "c-bad" }),
    );

    // The guard message was fed back as a role="tool" reply so the model
    // saw the valid-tool list on its next turn — the trace records the bad
    // call too, then the real one.
    expect(result.stop_reason).toBe("model_done");
    expect(result.trace.map((t) => t.tool)).toEqual([
      "knowledge_base_search",
      "search_content",
    ]);
  });

  // WARP-642 review (FINDING 1) — consecutive-guard-hit circuit breaker.
  // If the model keeps naming an unknown tool every turn (ignoring the
  // UNKNOWN_TOOL recovery message), the loop must NOT silently exhaust
  // maxIter and return a blank reply. After MAX_CONSECUTIVE_GUARD_HITS (3)
  // guard-only iterations it breaks early with stop_reason "error".
  it("circuit-breaks when the model repeatedly calls an unknown tool", async () => {
    const callTool = vi.fn();
    const badTurn = {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "c-bad",
                  type: "function",
                  function: {
                    name: "knowledge_base_search",
                    arguments: JSON.stringify({ query: "vacation policy" }),
                  },
                },
              ],
            },
          },
        ],
      }),
    };
    // Same hallucinated call on every iteration — enough times that a
    // non-breaking loop would run all maxIter iterations.
    const chat = vi
      .fn()
      .mockResolvedValue(badTurn);
    const events: SSEEvent[] = [];
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([
          {
            name: "search_content",
            description: "Hybrid search over docs + brain items.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
            },
          },
        ]),
        callTool,
      } as never,
      aiGateway: { chat } as never,
      onEvent: (e: SSEEvent) => events.push(e),
    };
    const result = await runAgent(deps, {
      model: "ollama/gpt-oss:20b",
      messages: [{ role: "user", content: "search the knowledge base" }],
    });

    // Never dispatched to the MCP child.
    expect(callTool).not.toHaveBeenCalled();
    // Stopped EARLY — exactly MAX_CONSECUTIVE_GUARD_HITS (3) chat turns,
    // not the full maxIter.
    expect(chat).toHaveBeenCalledTimes(3);
    // Ends with an error explaining the repeated unknown tool.
    expect(result.stop_reason).toBe("error");
    expect(result.error).toContain("knowledge_base_search");
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    if (done && done.type === "done") {
      expect(done.stop_reason).toBe("error");
    }
  });

  // WARP-642 review (FINDING 1 reset path) — a turn that dispatches a real
  // tool MUST reset the consecutive-guard-hit counter, so an occasional
  // hallucinated name interleaved with real progress can never accumulate to
  // a false circuit-break. Sequence: guard-only, guard-only (counter → 2),
  // mixed bad+good (real dispatch RESETS counter → 0), guard-only
  // (counter → 1), then the model answers. Without the reset the final
  // guard-only turn would tip the counter to 3 and stop with "error", so
  // stop_reason "model_done" is what proves the reset fired.
  it("resets the guard-hit circuit breaker after a real dispatch (mixed turn)", async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ data: { results: [] } }) }],
      isError: false,
    });
    const badTurn = (id: string) => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id,
                  type: "function",
                  function: { name: "knowledge_base_search", arguments: "{}" },
                },
              ],
            },
          },
        ],
      }),
    });
    // One turn carrying BOTH a hallucinated name and the real tool.
    const mixedTurn = (bad: string, good: string) => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: bad,
                  type: "function",
                  function: { name: "knowledge_base_search", arguments: "{}" },
                },
                {
                  id: good,
                  type: "function",
                  function: {
                    name: "search_content",
                    arguments: JSON.stringify({ query: "vacation policy" }),
                  },
                },
              ],
            },
          },
        ],
      }),
    });
    const chat = vi
      .fn()
      .mockResolvedValueOnce(badTurn("c-bad1"))
      .mockResolvedValueOnce(badTurn("c-bad2"))
      .mockResolvedValueOnce(mixedTurn("c-bad3", "c-good3"))
      .mockResolvedValueOnce(badTurn("c-bad4"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "Here is what I found." } }],
        }),
      });
    const events: SSEEvent[] = [];
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([
          {
            name: "search_content",
            description: "Hybrid search over docs + brain items.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
            },
          },
        ]),
        callTool,
      } as never,
      aiGateway: { chat } as never,
      onEvent: (e: SSEEvent) => events.push(e),
    };
    const result = await runAgent(deps, {
      model: "ollama/gpt-oss:20b",
      max_iter: 8,
      messages: [{ role: "user", content: "search the knowledge base for vacation policy" }],
    });

    // The valid tool was dispatched exactly once (the mixed turn); the
    // hallucinated name never reached the MCP child.
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool.mock.calls[0][0]).toBe("search_content");

    // The real dispatch reset the consecutive-guard-hit counter, so the
    // trailing guard-only turn did NOT trip the breaker — the loop reached
    // the model's final answer instead of erroring.
    expect(result.stop_reason).toBe("model_done");
    expect(result.error).toBeUndefined();
    expect(chat).toHaveBeenCalledTimes(5);

    // FINDING 2 — exactly one tool_call chip, for the single real dispatch;
    // never for a guard-rejected hallucinated name.
    expect(events.filter((e) => e.type === "tool_call").length).toBe(1);
    expect(
      events.find((e) => e.type === "tool_call" && e.name === "knowledge_base_search"),
    ).toBeUndefined();

    // Both the guard reply and the real tool reply from the mixed turn are
    // delivered to the model on the following chat() call.
    expect(chat.mock.calls[3][0].messages).toContainEqual(
      expect.objectContaining({ role: "tool", tool_call_id: "c-bad3" }),
    );
    expect(chat.mock.calls[3][0].messages).toContainEqual(
      expect.objectContaining({ role: "tool", tool_call_id: "c-good3" }),
    );
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

  // An explicit `allowed_tools: []` means "no tools" — it must NOT fall
  // through to advertising the full registry. `.length` truthiness used to
  // conflate the empty array with `undefined` (no restriction).
  it("allowed_tools: [] advertises ZERO tools (not the full set)", async () => {
    const chat = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "no tools here" } }],
      }),
    });
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([
          { name: "list_cameras", description: "...", inputSchema: { type: "object", properties: {} } },
          { name: "get_system_health", description: "...", inputSchema: { type: "object", properties: {} } },
        ]),
        callTool: vi.fn(),
      } as never,
      aiGateway: { chat } as never,
    };
    await runAgent(deps, {
      model: "ollama/qwen3",
      messages: [{ role: "user", content: "what time is it" }],
      allowed_tools: [],
    });
    expect(chat).toHaveBeenCalledTimes(1);
    expect((chat.mock.calls[0][0] as { tools: unknown[] }).tools).toEqual([]);
  });

  // The undefined case is "no restriction → the default chat scope"
  // (WARP-1424): everything except the chat-tool-scope.ts exclusions. The
  // empty-array fix must not clamp callers that omit allowed_tools.
  it("allowed_tools undefined forwards the default chat scope", async () => {
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
          { name: "get_system_health", description: "...", inputSchema: { type: "object", properties: {} } },
        ]),
        callTool: vi.fn(),
      } as never,
      aiGateway: { chat } as never,
    };
    await runAgent(deps, {
      model: "ollama/qwen3",
      messages: [{ role: "user", content: "list cameras" }],
      // allowed_tools intentionally omitted
    });
    expect((chat.mock.calls[0][0] as { tools: unknown[] }).tools).toHaveLength(2);
  });

  // WARP-1424 — the default chat advertisement excludes the specialist/admin
  // set (chat-tool-scope.ts): the post-WARP-1423 registry no longer fits the
  // shipping 16K window whole. An explicit allowed_tools still reaches the
  // excluded tools (that's how power callers and tests opt back in).
  it("default chat scope drops excluded tools; explicit allowed_tools restores them", async () => {
    const chat = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "done" } }],
      }),
    });
    const registry = [
      { name: "list_cameras", description: "...", inputSchema: { type: "object", properties: {} } },
      { name: "get_switch_ports", description: "...", inputSchema: { type: "object", properties: {} } },
    ];
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue(registry),
        callTool: vi.fn(),
      } as never,
      aiGateway: { chat } as never,
    };
    await runAgent(deps, {
      model: "ollama/qwen3",
      messages: [{ role: "user", content: "hi" }],
    });
    const defaultNames = (
      chat.mock.calls[0][0] as { tools: { function: { name: string } }[] }
    ).tools.map((t) => t.function.name);
    expect(defaultNames).toEqual(["list_cameras"]);

    await runAgent(deps, {
      model: "ollama/qwen3",
      messages: [{ role: "user", content: "hi" }],
      allowed_tools: ["get_switch_ports"],
    });
    const explicitNames = (
      chat.mock.calls[1][0] as { tools: { function: { name: string } }[] }
    ).tools.map((t) => t.function.name);
    expect(explicitNames).toEqual(["get_switch_ports"]);
  });

  // WARP-329 — client disconnect cancellation. The signal is forwarded to
  // the ai-gateway fetch so an in-flight inference call is cancelled.
  it("forwards req.signal to the ai-gateway chat call", async () => {
    const chat = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "ok" } }],
      }),
    });
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([]),
        callTool: vi.fn(),
      } as never,
      aiGateway: { chat } as never,
    };
    const controller = new AbortController();
    await runAgent(deps, {
      model: "ollama/qwen3",
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    });
    // Second positional arg is the AbortSignal.
    expect(chat.mock.calls[0][1]).toBe(controller.signal);
  });

  // WARP-329 — an already-aborted signal bails before the first inference
  // call, so a client that disconnected before the loop started burns zero
  // inference.
  it("bails before issuing any inference call when the signal is already aborted", async () => {
    const chat = vi.fn();
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([]),
        callTool: vi.fn(),
      } as never,
      aiGateway: { chat } as never,
    };
    const controller = new AbortController();
    controller.abort();
    const result = await runAgent(deps, {
      model: "ollama/qwen3",
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    });
    expect(chat).not.toHaveBeenCalled();
    expect(result.stop_reason).toBe("error");
    expect(result.error).toBe("client_aborted");
  });

  // WARP-329 — a disconnect that lands while a tool turn is queued must
  // stop BEFORE dispatching the (possibly write) tool to the MCP child.
  it("does not dispatch a tool once the client has disconnected mid-turn", async () => {
    const controller = new AbortController();
    const callTool = vi.fn();
    // Single turn asking for a tool call; the client disconnects as soon as
    // the inference response arrives, before the dispatch loop runs.
    const chat = vi.fn().mockImplementationOnce(async () => {
      controller.abort();
      return {
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
                    function: { name: "block_network_device", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
      };
    });
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([
          {
            name: "block_network_device",
            description: "...",
            inputSchema: { type: "object", properties: {} },
          },
        ]),
        callTool,
      } as never,
      aiGateway: { chat } as never,
    };
    const result = await runAgent(deps, {
      model: "ollama/qwen3",
      messages: [{ role: "user", content: "block the router" }],
      signal: controller.signal,
    });
    expect(callTool).not.toHaveBeenCalled();
    expect(result.stop_reason).toBe("error");
    expect(result.error).toBe("client_aborted");
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

  // WARP-1012 — a turn that exhausts the iteration budget used to return
  // an EMPTY assistant message (the customer saw a blank bubble while the
  // model burned every iteration retrying failing file tools). The loop
  // must emit an honest plain-language fallback instead.
  describe("iteration_limit honest fallback (WARP-1012)", () => {
    /** chat mock that ALWAYS issues the same tool call — never finalizes. */
    function alwaysToolCallChat(toolName: string) {
      let n = 0;
      return vi.fn().mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `c${++n}`,
                    type: "function",
                    function: { name: toolName, arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
      }));
    }

    function depsWith(
      chat: ReturnType<typeof vi.fn>,
      callTool: ReturnType<typeof vi.fn>,
      events: SSEEvent[],
    ): AgentDeps {
      return {
        mcp: {
          listTools: vi.fn().mockResolvedValue([
            {
              name: "search_files",
              description: "...",
              inputSchema: { type: "object", properties: {} },
            },
          ]),
          callTool,
        } as never,
        aiGateway: { chat } as never,
        onEvent: (e: SSEEvent) => events.push(e),
      };
    }

    it("emits a fallback naming the failing tool when tools kept erroring", async () => {
      const callTool = vi.fn().mockResolvedValue({
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              status: "error",
              error: { code: "SEARCH_FAILED", message: "nextcloud returned 400" },
            }),
          },
        ],
      });
      const events: SSEEvent[] = [];
      const result = await runAgent(
        depsWith(alwaysToolCallChat("search_files"), callTool, events),
        {
          model: "ollama/qwen3",
          messages: [{ role: "user", content: "find my tax file" }],
          max_iter: 2,
        },
      );
      expect(result.stop_reason).toBe("iteration_limit");
      // The customer-visible message must NOT be blank, must be honest
      // about the failure, and must land as a content_delta BEFORE done
      // (same ordering as the happy path so streaming persistence and
      // the non-streaming result both carry it).
      expect(typeof result.message.content).toBe("string");
      expect((result.message.content as string).length).toBeGreaterThan(0);
      expect(result.message.content).toContain("search_files");
      const deltaIdx = events.findIndex((e) => e.type === "content_delta");
      const doneIdx = events.findIndex((e) => e.type === "done");
      expect(deltaIdx).toBeGreaterThanOrEqual(0);
      expect(doneIdx).toBeGreaterThan(deltaIdx);
      const delta = events[deltaIdx] as Extract<SSEEvent, { type: "content_delta" }>;
      expect(delta.text).toBe(result.message.content);
      const done = events[doneIdx] as Extract<SSEEvent, { type: "done" }>;
      expect(done.stop_reason).toBe("iteration_limit");
    });

    it("emits a generic step-limit fallback when tools succeeded but budget ran out", async () => {
      const callTool = vi.fn().mockResolvedValue({
        isError: false,
        content: [
          { type: "text", text: JSON.stringify({ ok: true, data: { items: [] } }) },
        ],
      });
      const events: SSEEvent[] = [];
      const result = await runAgent(
        depsWith(alwaysToolCallChat("search_files"), callTool, events),
        {
          model: "ollama/qwen3",
          messages: [{ role: "user", content: "find my tax file" }],
          max_iter: 2,
        },
      );
      expect(result.stop_reason).toBe("iteration_limit");
      expect((result.message.content as string).length).toBeGreaterThan(0);
      // No failures → don't blame the tools by name.
      expect(result.message.content).not.toContain("search_files");
      expect(events.some((e) => e.type === "content_delta")).toBe(true);
    });
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

  it("conversational → minSimilarity=0.75, perArmK=50, no enhance", () => {
    // WARP-2196 recalibrated the floor from 0.5 (MiniLM) to 0.75 (bge).
    // The derivation is pinned in services/similarity-floors.test.ts.
    const p = presetForClass("conversational");
    expect(p.searchOverrides?.minSimilarity).toBe(0.75);
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
