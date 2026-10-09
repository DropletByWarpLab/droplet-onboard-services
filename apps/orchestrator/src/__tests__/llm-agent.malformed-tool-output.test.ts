/**
 * WARP-3284 — a tool whose output is truncated or otherwise unparseable
 * JSON used to arrive as a successful `{ raw }`: SSE `ok: true`, and the
 * model reported "I don't have the list" instead of a failure. It is now an
 * explicit TOOL_OUTPUT_MALFORMED failure.
 *
 * The split is by SOURCE, not by the text's first character: a local tool's
 * output is always `JSON.stringify` (mcp-server), so any non-JSON from one is
 * broken. A namespaced remote MCP (`<serverId>__*`) or extension
 * (`ext-<slug>__*`) tool passes its upstream's text through verbatim, and
 * plain text — `[INFO] 3 matches`, `{{name}} updated` — is a normal success.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const logged = vi.hoisted(() => [] as Array<{ level: string; obj: Record<string, unknown>; msg: string }>);
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
beforeEach(() => {
  logged.length = 0;
});
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";
import type { AgentCheckpointPort } from "../services/llm-agent.service.js";
import type { SSEEvent } from "../types/sse-events.js";
import { stepResultValue } from "../services/tool-spec-runner.service.js";

function run(toolText: string, tool = "business_find") {
  const events: SSEEvent[] = [];
  const checkpointed: Array<{ text: string; isError: boolean }> = [];
  const checkpoint: AgentCheckpointPort = {
    async onIteration() {},
    async beforeToolCall() {
      return undefined;
    },
    async afterToolCall(call) {
      checkpointed.push({ text: call.text, isError: call.isError });
    },
  };
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
              tool_calls: [{ id: "c1", type: "function", function: { name: tool, arguments: '{"entity":"work_item"}' } }],
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
      listTools: vi.fn().mockResolvedValue([{ name: tool, description: "d", inputSchema: {} }]),
      callTool: vi.fn().mockResolvedValue({ isError: false, content: [{ type: "text", text: toolText }] }),
    } as never,
    aiGateway: { chat } as never,
    onEvent: (e) => events.push(e),
  };
  return runAgent(deps, { model: "m", messages: [{ role: "user", content: "list open work items" }], checkpoint }).then(
    (result) => {
      const toolMsg = (chat.mock.calls[1]![0] as { messages: { role: string; content: unknown }[] }).messages.find(
        (m) => m.role === "tool",
      )!;
      const evt = events.find((e) => e.type === "tool_result") as Extract<SSEEvent, { type: "tool_result" }>;
      return { result, toolMsg: String(toolMsg.content), evt, checkpointed };
    },
  );
}

describe("runAgent — malformed tool output (WARP-3284)", () => {
  it("truncated JSON from a local tool is a TOOL_OUTPUT_MALFORMED failure, not a success", async () => {
    const { result, toolMsg, evt } = await run('{"items": [{"id": "SUP-');
    expect(evt.ok).toBe(false);
    const model = JSON.parse(toolMsg);
    expect(model.status).toBe("error");
    expect(model.error.code).toBe("TOOL_OUTPUT_MALFORMED");
    // The action may have committed before the reply was cut: never invite a retry.
    expect(model.error.message).toContain("may still have run");
    expect(model.error.message).toContain("do not repeat the call");
    // The fragment is never presented to the model as data.
    expect(toolMsg).not.toContain("SUP-");
    // The trace keeps a bounded excerpt for diagnosis.
    const traced = result.trace[0]!.result as { error: { code: string }; raw: string };
    expect(traced.error.code).toBe("TOOL_OUTPUT_MALFORMED");
    expect(traced.raw).toBe('{"items": [{"id": "SUP-');
  });

  it("the durable-run checkpoint records the malformed call as FAILED, with the wire text for replay", async () => {
    const { checkpointed } = await run('{"items": [{"id": "SUP-');
    expect(checkpointed).toEqual([{ text: '{"items": [{"id": "SUP-', isError: true }]);
  });

  it("logs the failure, and does not count the envelope swap as a size reduction", async () => {
    await run('{"items": [{"id": "SUP-');
    expect(logged.some((l) => l.msg === "agent_tool_error" && l.obj.tool === "business_find")).toBe(true);
    const size = logged.find((l) => l.msg === "agent_tool_result_size")!;
    expect(size.obj.reduced).toBe(false);
  });

  it("a well-formed upstream envelope that merely CARRIES the code is not a parse failure", async () => {
    const text = JSON.stringify({ items: [], error: { code: "TOOL_OUTPUT_MALFORMED" } });
    const { evt, toolMsg, checkpointed } = await run(text);
    expect(evt.ok).toBe(true);
    expect(toolMsg).toBe(text);
    expect(checkpointed[0]!.isError).toBe(false);
  });

  it("any non-JSON from a local tool is malformed — a quote-rooted fragment and empty text too", async () => {
    for (const text of ['"half a str', "", "plain words"]) {
      const { evt, toolMsg } = await run(text);
      expect(evt.ok).toBe(false);
      expect(JSON.parse(toolMsg).error.code).toBe("TOOL_OUTPUT_MALFORMED");
    }
  });

  it("bounds the diagnostic excerpt", async () => {
    const { result } = await run(`[${"x".repeat(5000)}`);
    expect((result.trace[0]!.result as { raw: string }).raw.length).toBeLessThanOrEqual(200);
  });

  it("plain text from a remote MCP or extension tool stays a success — even when it starts with { or [", async () => {
    for (const [tool, text] of [
      ["atlassian__jira_search", "[INFO] 3 matches\n- SUP-1 Printer offline"],
      ["atlassian__jira_search", "[ ] Printer offline"],
      ["ext-notes__render", "{{name}} was updated"],
      ["ext-notes__render", "## Open issues\n- SUP-1 Printer offline"],
    ] as const) {
      const { toolMsg, evt, checkpointed } = await run(text, tool);
      expect(evt.ok).toBe(true);
      // WARP-3920 — the model gets it inside the untrusted-data block.
      expect(toolMsg).toContain("<<<UNTRUSTED REMOTE TOOL RESULT");
      expect(toolMsg).toContain(text);
      expect(checkpointed[0]!.isError).toBe(false);
    }
  });

  it("an extension body cut at the 32 KiB cap reaches the model with its truncation marker", async () => {
    const text = `{"rows": [1, 2\n[truncated: the extension returned 40000 bytes; the first 32768 are shown]`;
    const { toolMsg, evt } = await run(text, "ext-crm__list_rows");
    expect(evt.ok).toBe(true);
    expect(toolMsg).toContain("[truncated: the extension returned 40000 bytes");
  });
});

describe("ToolSpec step dispatch — malformed tool output (WARP-3284)", () => {
  const wire = (text: string, isError = false) => ({ isError, content: [{ type: "text", text }] });

  it("a local tool's unreadable reply fails the step instead of passing a fragment downstream", () => {
    expect(() => stepResultValue("business_find", wire('{"items": [{"id": "SUP-'))).toThrow(/TOOL_OUTPUT_MALFORMED/);
  });

  it("keeps the historical shapes: parsed JSON, a remote tool's text as { raw }, empty as null, isError throws", () => {
    expect(stepResultValue("business_find", wire('{"items":[]}'))).toEqual({ items: [] });
    expect(stepResultValue("atlassian__jira_search", wire("[INFO] 3 matches"))).toEqual({ raw: "[INFO] 3 matches" });
    expect(stepResultValue("business_find", wire(""))).toBeNull();
    expect(() => stepResultValue("business_find", wire('{"status":"error"}', true))).toThrow('{"status":"error"}');
  });
});
