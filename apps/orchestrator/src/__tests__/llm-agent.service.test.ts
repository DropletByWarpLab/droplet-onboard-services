import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";
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
    expect(callTool).toHaveBeenCalledWith("list_network_devices", {});
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
});
