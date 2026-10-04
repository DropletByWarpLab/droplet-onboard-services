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

function makeDeps(
  turns: unknown[],
  poolToolNames: string[] = ["search_content"],
) {
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
        .mockResolvedValue(
          poolToolNames.map((name) => ({ name, description: "d", inputSchema: {} })),
        ),
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

  // Regression: a flat `JSON.stringify(args, Object.keys(args).sort())`
  // replacer array applies the top-level key whitelist at EVERY nesting
  // level, so nested object keys vanish and two calls with different
  // nested payloads (e.g. different `zones[].name`) both serialize to the
  // same string and falsely collide as "repetition".
  it("nested args that differ are not repetition", async () => {
    const zoneCall = (id: string, zoneName: string) => ({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id,
          type: "function",
          function: {
            name: "set_detection_zones",
            arguments: JSON.stringify({
              camera: "front_door",
              zones: [{ name: zoneName }],
            }),
          },
        },
      ],
    });
    const { deps, chat, callTool } = makeDeps(
      [
        zoneCall("c1", "driveway"),
        zoneCall("c2", "backyard"),
        { role: "assistant", content: "zones updated" },
      ],
      ["set_detection_zones"],
    );
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "update the detection zones" }],
      allowed_tools: ["set_detection_zones"],
      max_iter: 10,
    });
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(result.stop_reason).toBe("model_done");
    const allMessages = chat.mock.calls.flatMap(
      (c) => (c[0] as { messages: { content: unknown }[] }).messages,
    );
    expect(
      allMessages.some((m) => String(m.content).includes("REPEATED_CALL")),
    ).toBe(false);
  });

  it("top-level key order does not defeat detection", async () => {
    const callA = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "search_content", arguments: '{"a":1,"b":{"x":2}}' },
        },
      ],
    };
    const callB = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c2",
          type: "function",
          function: { name: "search_content", arguments: '{"b":{"x":2},"a":1}' },
        },
      ],
    };
    const { deps, chat, callTool } = makeDeps([
      callA,
      callB,
      { role: "assistant", content: "done" },
    ]);
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "run it" }],
      max_iter: 10,
    });
    expect(callTool).toHaveBeenCalledTimes(1);
    const lastReq = chat.mock.calls[chat.mock.calls.length - 1]![0] as {
      messages: { content: unknown }[];
    };
    expect(
      lastReq.messages.filter((m) => String(m.content).includes("REPEATED_CALL"))
        .length,
    ).toBe(1);
    expect(result.stop_reason).toBe("model_done");
  });
});

/**
 * WARP-3287 — only a call that SUCCEEDED has a result to point at. A READ that
 * failed transiently is re-dispatched, a write never is; a tool that failed
 * twice in a row is refused (honestly), then finalized. Eval seed-014 / adv-009.
 */
describe("runAgent — repetition guard after a failed call (WARP-3287)", () => {
  const callOf = (id: string, name: string, args: Record<string, unknown>) => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  });
  const searchCall = (id: string, query: string) => callOf(id, "search_content", { query });
  const OK = { isError: false, content: [{ type: "text", text: '{"hits":[]}' }] };
  const failure = (code: string, message = "x") => ({
    isError: true,
    content: [
      { type: "text", text: JSON.stringify({ status: "error", error: { code, message } }) },
    ],
  });
  const TIMEOUT = failure("TIMEOUT", "The tool did not respond within 30 s.");
  const refusals = (chat: ReturnType<typeof makeDeps>["chat"]) => {
    const last = chat.mock.calls[chat.mock.calls.length - 1]![0] as {
      messages: { role: string; content: unknown }[];
    };
    return last.messages
      .filter((m) => m.role === "tool" && String(m.content).includes("REPEATED_CALL"))
      .map((m) => String(m.content));
  };
  const run = (deps: AgentDeps, allowed_tools?: string[]) =>
    runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "search, retry once if it times out" }],
      max_iter: 10,
      ...(allowed_tools ? { allowed_tools } : {}),
    });

  it("seed-014: an identical retry of a timed-out call is dispatched", async () => {
    const { deps, chat, callTool } = makeDeps([
      sameCall, // TIMEOUT
      sameCall, // the retry the user asked for
      { role: "assistant", content: "600 requests per minute" },
    ]);
    callTool.mockResolvedValueOnce(TIMEOUT);
    const result = await run(deps);
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(refusals(chat)).toEqual([]);
    expect(result.stop_reason).toBe("model_done");
  });

  it.each([
    ["UPSTREAM_UNAVAILABLE", failure("UPSTREAM_UNAVAILABLE")],
    ["HANDLER_THREW with a network cause", failure("HANDLER_THREW", "fetch failed; cause: read ECONNRESET")],
    ["an upstream 503", failure("READ_FAILED", "the File Store returned 503")],
    ["a bare string error with a network cause", { isError: true, content: [{ type: "text", text: '{"error":"socket hang up"}' }] }],
    ["unreadable output (WARP-3284)", { isError: false, content: [{ type: "text", text: '{"hits": [{"id": "SUP-' }] }],
  ])("retries after %s", async (_label, first) => {
    const { deps, callTool } = makeDeps([
      sameCall,
      sameCall,
      { role: "assistant", content: "done" },
    ]);
    callTool.mockResolvedValueOnce(first);
    await run(deps);
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it("retries after a thrown dispatch (tool_dispatch_failed)", async () => {
    const { deps, callTool } = makeDeps([
      sameCall,
      sameCall,
      { role: "assistant", content: "done" },
    ]);
    callTool.mockRejectedValueOnce(new Error("MCP child exited"));
    await run(deps);
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["INVALID_ARGS", failure("INVALID_ARGS", "query is required")],
    ["HANDLER_THREW without a network cause", failure("HANDLER_THREW", "TypeError: x is not a function")],
    // "unterminated" contains "terminated": a network class counts only on the codes that carry a cause.
    ["PARSE_FAILED whose message matches a network class", failure("PARSE_FAILED", "unterminated quoted field")],
  ])("does not retry %s, and says the call failed", async (_label, first) => {
    const { deps, chat, callTool } = makeDeps([
      sameCall,
      sameCall,
      { role: "assistant", content: "it failed" },
    ]);
    callTool.mockResolvedValueOnce(first);
    await run(deps);
    expect(callTool).toHaveBeenCalledTimes(1);
    const [nudge] = refusals(chat);
    expect(nudge).toContain("it failed (");
    expect(nudge).not.toContain("its result is in the conversation above");
  });

  it("stops a call that keeps timing out after its one retry", async () => {
    const { deps, chat, callTool } = makeDeps([
      sameCall, // TIMEOUT
      sameCall, // retry: TIMEOUT
      sameCall, // refused
      sameCall, // refused + finalize
      { role: "assistant", content: "the search is failing" },
    ]);
    callTool.mockResolvedValue(TIMEOUT);
    const result = await run(deps);
    expect(callTool).toHaveBeenCalledTimes(2);
    const nudges = refusals(chat);
    expect(nudges).toHaveLength(2);
    expect(nudges[0]).toContain("2 times in a row and it failed each time (last error: TIMEOUT)");
    expect(nudges[0]).not.toContain("its result is in the conversation above");
    const finalReq = chat.mock.calls[4]![0] as { tools: unknown[] };
    expect(finalReq.tools).toEqual([]);
    expect(result.stop_reason).toBe("repetition");
  });

  it("adv-009: a reworded call to a tool that failed twice is refused, not dispatched", async () => {
    const malformed = { isError: false, content: [{ type: "text", text: '{"items": [{"id": "SUP-' }] };
    const { deps, chat, callTool } = makeDeps([
      searchCall("c1", "open work items"),
      searchCall("c2", "open work items limit 10"),
      searchCall("c3", "open"), // tool is down: refused, whatever the arguments
      { role: "assistant", content: "the lookup is failing" },
    ]);
    callTool.mockResolvedValue(malformed);
    const result = await run(deps);
    expect(callTool).toHaveBeenCalledTimes(2);
    const nudges = refusals(chat);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toContain("already called 'search_content' 2 times in a row");
    expect(nudges[0]).toContain("TOOL_OUTPUT_MALFORMED");
    // One refusal nudges; it does not finalize on its own.
    expect(result.stop_reason).toBe("model_done");
  });

  it("a success clears the failure: the next repeat gets the ordinary nudge, the tool's count restarts", async () => {
    const { deps, chat, callTool } = makeDeps([
      sameCall, // TIMEOUT
      sameCall, // retry: ok
      sameCall, // ordinary §4 nudge — its result now exists
      searchCall("c2", "marc"), // TIMEOUT: the tool's first failure since the success
      searchCall("c3", "anna"), // dispatched: the tool is not down
      { role: "assistant", content: "done" },
    ]);
    callTool
      .mockResolvedValueOnce(TIMEOUT)
      .mockResolvedValueOnce(OK)
      .mockResolvedValueOnce(TIMEOUT);
    await run(deps);
    expect(callTool).toHaveBeenCalledTimes(4);
    const nudges = refusals(chat);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toContain("its result is in the conversation above");
  });

  it("never repeats a write whose outcome is unknown: create_event timed out", async () => {
    const event = callOf("c1", "create_event", { title: "Board meeting", start: "2026-10-01T09:00" });
    const { deps, chat, callTool } = makeDeps(
      [event, event, { role: "assistant", content: "it may already be on the calendar" }],
      ["create_event"],
    );
    callTool.mockResolvedValueOnce(TIMEOUT);
    await run(deps, ["create_event"]);
    // The POST may have landed; a second dispatch would be a second event.
    expect(callTool).toHaveBeenCalledTimes(1);
    const [nudge] = refusals(chat);
    expect(nudge).toContain("failed (TIMEOUT), but it may already have happened");
    expect(nudge).toContain("check before retrying");
    expect(nudge).not.toContain("its result is in the conversation above");
  });

  it("a success of ANY tool clears the failure counts, so a tool is not locked out for the rest of a long run", async () => {
    const { deps, chat, callTool } = makeDeps(
      [
        searchCall("c1", "a"), // TIMEOUT
        searchCall("c2", "b"), // TIMEOUT: search_content is down
        searchCall("c3", "c"), // refused
        callOf("c4", "calculate", { expression: "1+1" }), // ok: clears the counts
        searchCall("c5", "c"), // dispatched again — neither down nor counted by its refusal
        { role: "assistant", content: "done" },
      ],
      ["search_content", "calculate"],
    );
    callTool.mockResolvedValueOnce(TIMEOUT).mockResolvedValueOnce(TIMEOUT);
    const result = await run(deps, ["search_content", "calculate"]);
    expect(callTool.mock.calls.map((c) => c[0])).toEqual([
      "search_content",
      "search_content",
      "calculate",
      "search_content",
    ]);
    expect(refusals(chat)).toHaveLength(1);
    expect(result.stop_reason).toBe("model_done");
  });

  it("a repeat of a call that SUCCEEDED keeps the §4 message and steps while its tool is down", async () => {
    const { deps, chat, callTool } = makeDeps([
      sameCall, // ok
      searchCall("c2", "b"), // TIMEOUT
      searchCall("c3", "c"), // TIMEOUT: search_content is down
      sameCall, // §4 nudge: its result does exist
      sameCall, // §4 nudge + finalize
      { role: "assistant", content: "here is what I found" },
    ]);
    callTool
      .mockResolvedValueOnce(OK)
      .mockResolvedValueOnce(TIMEOUT)
      .mockResolvedValueOnce(TIMEOUT);
    const result = await run(deps);
    expect(callTool).toHaveBeenCalledTimes(3);
    const nudges = refusals(chat);
    expect(nudges).toHaveLength(2);
    for (const n of nudges) expect(n).toContain("its result is in the conversation above");
    expect(result.stop_reason).toBe("repetition");
  });
});
