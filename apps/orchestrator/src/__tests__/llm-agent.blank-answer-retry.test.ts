/**
 * WARP-3285 — a blank answer after real tool work never reaches the user.
 *
 * Eval evidence (gpt-oss:20b on DMR, stage @74a020177): every blank final
 * answer (11 of 198 turns) was `cause: "reasoning_only"` on a finalize pass
 * — the model ended in its analysis channel still planning a tool call — and
 * 11 of the 12 finalize passes (no_progress / repetition) came back blank.
 * Two causes, two pins:
 *
 *   1. The finalize nudge was a mid-conversation `system` message, which the
 *      gpt-oss chat template silently drops (only messages[0] becomes the
 *      developer block). It is now a `user` message.
 *   2. A blank after tool work — on a finalize pass or a normal one — gets ONE
 *      no-tools retry with an explicit ask, then a plain-language fallback
 *      that says what was checked. Never an extra call beyond that, and never
 *      past `max_iter`.
 */
import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";
import type { ChatStreamChunk } from "../types/index.js";
import type { SSEEvent } from "../types/sse-events.js";

type Req = {
  tools: unknown[];
  tool_choice: string;
  messages: { role: string; content: unknown }[];
};

let n = 0;
const call = (name: string, args: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: null,
  tool_calls: [
    { id: `c${++n}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
  ],
});
/** What the eval's blank turns looked like: analysis only, no content. */
const reasoningOnly = (thought: string) => ({
  role: "assistant",
  content: "",
  reasoning_content: thought,
});
const says = (content: string) => ({ role: "assistant", content });

const TOOLS = ["search_content", "search_contacts", "memory_recall"];

function blockingDeps(respond: (req: Req) => unknown) {
  const events: SSEEvent[] = [];
  // The loop reuses ONE messages array across calls; snapshot each request.
  const requests: Req[] = [];
  const chat = vi.fn().mockImplementation(async (req: Req) => {
    requests.push({ ...req, messages: [...req.messages] });
    return {
      ok: true,
      json: async () => ({ choices: [{ message: respond(req), finish_reason: "stop" }] }),
    };
  });
  const deps: AgentDeps = {
    mcp: {
      listTools: vi
        .fn()
        .mockResolvedValue(TOOLS.map((name) => ({ name, description: "d", inputSchema: {} }))),
      callTool: vi.fn().mockImplementation(async (name: string) => ({
        isError: false,
        content: [
          {
            type: "text",
            text:
              name === "search_content"
                ? JSON.stringify({ query: "q", results: [] })
                : JSON.stringify({ contacts: [{ name: "Dave Ortiz", email: "dave@example.com" }] }),
          },
        ],
      })),
    } as never,
    aiGateway: { chat } as never,
    onEvent: (e) => events.push(e),
  };
  return { deps, chat, events, requests };
}

const lastMessage = (req: Req) => req.messages[req.messages.length - 1]!;
const streamedText = (events: SSEEvent[]) =>
  events.map((e) => (e.type === "content_delta" ? e.text : "")).join("");

describe("runAgent — blank answer after tool work (WARP-3285)", () => {
  it("a reasoning-only finalize pass gets one retry, and both nudges are user messages", async () => {
    // seed-009 / adv-007 / adv-010: rephrased searches → no_progress finalize
    // → the model keeps planning ("Let's search contacts.") and says nothing.
    const queries = ["manager email", "manager", "team lead"];
    let finalizePasses = 0;
    const { deps, chat, requests } = blockingDeps((req) => {
      if (req.tools.length > 0) return call("search_content", { query: queries[chat.mock.calls.length - 1] });
      return ++finalizePasses === 1
        ? reasoningOnly("We cannot find manager email. Maybe manager is a person in contacts. Let's search contacts.")
        : says("I searched for your manager's email and found nothing. Who is your manager?");
    });

    const result = await runAgent(deps, {
      model: "gpt-oss:20b",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "Send a message to the manager saying hello." },
      ],
    });

    expect(chat).toHaveBeenCalledTimes(5); // 3 searches + finalize + retry
    const [finalize, retry] = [requests[3]!, requests[4]!];
    for (const req of [finalize, retry]) {
      expect(req.tools).toEqual([]);
      expect(req.tool_choice).toBe("none");
      // Root cause: gpt-oss's template renders only messages[0] as system.
      expect(req.messages.slice(1).some((m) => m.role === "system")).toBe(false);
      expect(lastMessage(req).role).toBe("user");
    }
    expect(String(lastMessage(finalize).content)).toContain("found nothing");
    expect(String(lastMessage(retry).content)).toContain("haven't replied");
    // The blank pass itself is not replayed to the model as an empty answer.
    expect(retry.messages.filter((m) => m.role === "assistant" && m.content === "")).toHaveLength(0);

    expect(result.stop_reason).toBe("no_progress");
    expect(result.message.content).toBe(
      "I searched for your manager's email and found nothing. Who is your manager?",
    );
    expect(result.blankDiagnostics).toBeUndefined();
    // The blank pass's thinking is kept, not dropped.
    expect(result.message.reasoning).toContain("Let's search contacts.");
  });

  it("a blank model_done on a tool-advertising pass is retried without tools", async () => {
    // seed-028 / adv-020: tools still advertised, the model just stops.
    const { deps, chat } = blockingDeps((req) => {
      const i = chat.mock.calls.length;
      if (i === 1) return call("search_contacts", { query: "dave@example.com" });
      if (i === 2) return reasoningOnly("Need an email account id. Let's recall memory.");
      expect(req.tools).toEqual([]);
      return says("Dave Ortiz is dave@example.com. Which account should I send from?");
    });

    const result = await runAgent(deps, {
      model: "gpt-oss:20b",
      messages: [{ role: "user", content: "look up dave@example.com, then message him" }],
    });

    expect(chat).toHaveBeenCalledTimes(3);
    expect((chat.mock.calls[1]![0] as Req).tools.length).toBeGreaterThan(0);
    expect(result.stop_reason).toBe("model_done");
    expect(result.iterations).toBe(3);
    expect(result.message.content).toContain("Which account should I send from?");
    expect(result.blankDiagnostics).toBeUndefined();
  });

  it("still blank after the retry → a fallback naming what was checked, and no further call", async () => {
    const { deps, chat, events } = blockingDeps((req) =>
      req.tools.length > 0 && chat.mock.calls.length === 1
        ? call("search_contacts", { query: "dave" })
        : reasoningOnly("Let's search again."),
    );

    const result = await runAgent(deps, {
      model: "gpt-oss:20b",
      messages: [{ role: "user", content: "look up dave" }],
    });

    expect(chat).toHaveBeenCalledTimes(3); // tool, blank, ONE retry
    expect(result.stop_reason).toBe("model_done");
    expect(result.message.content).toMatch(/^I looked into this \(search_contacts\) but couldn't/);
    expect(streamedText(events)).toBe(result.message.content);
    // The attribution survives: the words are ours, not the model's.
    expect(result.blankDiagnostics).toMatchObject({ cause: "reasoning_only", toolCalls: 1 });
    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({ stop_reason: "model_done" });
  });

  it("no iteration left for a retry → the fallback, without exceeding max_iter", async () => {
    const { deps, chat } = blockingDeps(() =>
      chat.mock.calls.length === 1 ? call("search_contacts") : says(""),
    );

    const result = await runAgent(deps, {
      model: "gpt-oss:20b",
      messages: [{ role: "user", content: "look up dave" }],
      max_iter: 2,
    });

    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.iterations).toBe(2);
    expect(result.message.content).toMatch(/couldn't put together an answer/);
    expect(result.blankDiagnostics?.cause).toBe("model_returned_nothing");
  });
});

describe("runAgent — blank answer after tool work, streaming transport (WARP-3285)", () => {
  function toolCallChunk(name: string): ChatStreamChunk {
    return {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: `s${++n}`, type: "function" as const, function: { name, arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
  }
  const reasoningChunk = (text: string): ChatStreamChunk => ({
    choices: [{ delta: { reasoning: text } as never, finish_reason: "stop" }],
  });
  const contentChunk = (text: string): ChatStreamChunk => ({
    choices: [{ delta: { content: text }, finish_reason: "stop" }],
  });

  function streamingDeps(turns: ChatStreamChunk[][]) {
    const events: SSEEvent[] = [];
    const requests: Req[] = [];
    const chatStream = vi.fn((req: Req) => {
      requests.push(req);
      const chunks = turns[Math.min(requests.length - 1, turns.length - 1)]!;
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    });
    const chat = vi.fn();
    const deps: AgentDeps = {
      mcp: {
        listTools: vi
          .fn()
          .mockResolvedValue(TOOLS.map((name) => ({ name, description: "d", inputSchema: {} }))),
        callTool: vi.fn().mockResolvedValue({
          isError: false,
          content: [{ type: "text", text: JSON.stringify({ contacts: [{ name: "Dave Ortiz" }] }) }],
        }),
      } as never,
      aiGateway: { chat, chatStream } as never,
      onEvent: (e) => events.push(e),
    };
    return { deps, events, requests, chat };
  }

  it("the retry's streamed answer is what the user sees and what persists", async () => {
    const { deps, events, requests, chat } = streamingDeps([
      [toolCallChunk("search_contacts")],
      [reasoningChunk("Need the account id. Let's recall memory.")],
      [contentChunk("Dave Ortiz — "), contentChunk("which account should I send from?")],
    ]);

    const result = await runAgent(deps, {
      model: "gpt-oss:20b",
      messages: [{ role: "user", content: "look up dave, then message him" }],
      captureReasoning: true,
    });

    expect(requests).toHaveLength(3);
    expect(requests[2]!.tools).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
    expect(result.message.content).toBe("Dave Ortiz — which account should I send from?");
    expect(streamedText(events)).toBe(result.message.content);
    expect(result.stop_reason).toBe("model_done");
  });

  it("a streamed fallback reaches the wire (a terminal stream counts as already released)", async () => {
    const { deps, events, requests } = streamingDeps([
      [toolCallChunk("search_contacts")],
      [reasoningChunk("Let's search contacts again.")],
    ]);

    const result = await runAgent(deps, {
      model: "gpt-oss:20b",
      messages: [{ role: "user", content: "look up dave" }],
    });

    expect(requests).toHaveLength(3);
    expect(result.message.content).toMatch(/^I looked into this \(search_contacts\)/);
    // WARP-1442's sum invariant: the wire and the persisted row agree.
    expect(streamedText(events)).toBe(result.message.content);
  });
});
