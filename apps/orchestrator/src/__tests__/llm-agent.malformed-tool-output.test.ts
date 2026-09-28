/**
 * WARP-3284 — a tool whose output is truncated or otherwise unparseable
 * JSON used to arrive as a successful `{ raw }`: SSE `ok: true`, and the
 * model reported "I don't have the list" instead of a failure. It is now an
 * explicit TOOL_OUTPUT_MALFORMED failure. Plain text that never claimed to
 * be JSON (remote MCP servers and extensions return markdown on success)
 * is still a success.
 */
import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";
import type { SSEEvent } from "../types/sse-events.js";

function run(toolText: string) {
  const events: SSEEvent[] = [];
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
                { id: "c1", type: "function", function: { name: "business_find", arguments: '{"entity":"work_item"}' } },
              ],
            },
          },
        ],
      }),
    })
    .mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { role: "assistant", content: "answer" } }] }),
    });
  const deps: AgentDeps = {
    mcp: {
      listTools: vi.fn().mockResolvedValue([{ name: "business_find", description: "d", inputSchema: {} }]),
      callTool: vi.fn().mockResolvedValue({ isError: false, content: [{ type: "text", text: toolText }] }),
    } as never,
    aiGateway: { chat } as never,
    onEvent: (e) => events.push(e),
  };
  return runAgent(deps, { model: "m", messages: [{ role: "user", content: "list open work items" }] }).then(
    (result) => {
      const toolMsg = (chat.mock.calls[1]![0] as { messages: { role: string; content: unknown }[] }).messages.find(
        (m) => m.role === "tool",
      )!;
      const evt = events.find((e) => e.type === "tool_result") as Extract<SSEEvent, { type: "tool_result" }>;
      return { result, toolMsg: String(toolMsg.content), evt };
    },
  );
}

describe("runAgent — malformed tool output (WARP-3284)", () => {
  it("truncated JSON is a TOOL_OUTPUT_MALFORMED failure, not a success", async () => {
    const { result, toolMsg, evt } = await run('{"items": [{"id": "SUP-');
    expect(evt.ok).toBe(false);
    const model = JSON.parse(toolMsg);
    expect(model.status).toBe("error");
    expect(model.error.code).toBe("TOOL_OUTPUT_MALFORMED");
    // The fragment is never presented to the model as data.
    expect(toolMsg).not.toContain("SUP-");
    // The trace keeps a bounded excerpt for diagnosis.
    const traced = result.trace[0]!.result as { error: { code: string }; raw: string };
    expect(traced.error.code).toBe("TOOL_OUTPUT_MALFORMED");
    expect(traced.raw).toBe('{"items": [{"id": "SUP-');
  });

  it("bounds the diagnostic excerpt", async () => {
    const { result } = await run(`[${"x".repeat(5000)}`);
    expect((result.trace[0]!.result as { raw: string }).raw.length).toBeLessThanOrEqual(200);
  });

  it("plain text from a remote MCP server or extension stays a success", async () => {
    const { toolMsg, evt } = await run("## Open issues\n- SUP-1 Printer offline");
    expect(evt.ok).toBe(true);
    expect(toolMsg).toContain("Printer offline");
  });
});
