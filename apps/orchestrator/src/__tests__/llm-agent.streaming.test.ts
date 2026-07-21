/**
 * WARP-1442 (PR 2/2) — SERVER-SIDE token streaming through the agent loop.
 *
 * When the caller streams (`onEvent` present) AND the injected ai-gateway
 * exposes `chatStream`, `runAgent` consumes an OpenAI-compat token stream and
 * emits `content_delta` INCREMENTALLY as the model generates — instead of one
 * delta after the full blocking decode. This file pins the new behaviour AND
 * the backward-compat contract the dashboard + voice depend on:
 *
 *   - multi-chunk content → many content_delta events whose concatenation is
 *     byte-identical to the old single-delta answer, and persists the same
 *     `message.content`;
 *   - the event contract (content_delta / tool_call / tool_result / reasoning_
 *     step / done) is unchanged in TYPE and ORDER — only content_delta
 *     granularity increases;
 *   - a streamed tool-call turn accumulates tool-call fragments BY INDEX into a
 *     valid call, runs the EXISTING dispatch, and iterates;
 *   - gpt-oss `reasoning_content` is separated from content, emitted as a
 *     reasoning_step BEFORE content, stripped from the answer (WARP-458/495);
 *   - an empty / bare-JSON stream emits NO content_delta so WARP-854's
 *     empty-completion rewrite still fires;
 *   - a mid-stream client disconnect (WARP-329) tears the Ollama stream down
 *     and returns the aborted terminal;
 *   - `reasoning_effort` (WARP-1442a) rides the streaming request too;
 *   - and the non-streaming path (no `chatStream`, or no `onEvent`) is
 *     byte-for-byte the blocking behaviour, incl. the `chat()` fallback when
 *     the streaming transport throws.
 */
import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";
import type { ChatStreamChunk } from "../types/index.js";
import type { SSEEvent } from "../types/sse-events.js";

/** An async iterable over a fixed list of chunks (one chat turn). */
function streamOf(chunks: ChatStreamChunk[]): AsyncIterable<ChatStreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

/** Wrap plain content strings as terminal-`stop` content chunks. */
function contentChunks(parts: string[]): ChatStreamChunk[] {
  return parts.map((text, i) => ({
    choices: [
      {
        delta: { content: text },
        finish_reason: i === parts.length - 1 ? "stop" : null,
      },
    ],
  }));
}

function collectingDeps(
  chatStream: AgentDeps["aiGateway"]["chatStream"],
  opts: { callTool?: ReturnType<typeof vi.fn>; tools?: unknown[] } = {},
): { deps: AgentDeps; events: SSEEvent[]; chat: ReturnType<typeof vi.fn> } {
  const events: SSEEvent[] = [];
  // The blocking `chat()` is the fallback — assert it is NOT called on the
  // happy streaming path.
  const chat = vi.fn();
  const deps: AgentDeps = {
    mcp: {
      listTools: vi.fn().mockResolvedValue(opts.tools ?? []),
      callTool: opts.callTool ?? vi.fn(),
    } as never,
    aiGateway: { chat, chatStream } as never,
    onEvent: (e: SSEEvent) => events.push(e),
  };
  return { deps, events, chat };
}

const REQ = {
  model: "gpt-oss:20b",
  messages: [{ role: "user" as const, content: "hi" }],
};

describe("runAgent — server-side token streaming (WARP-1442)", () => {
  it("emits MANY content_delta as tokens arrive; concatenation == final answer", async () => {
    const { deps, events, chat } = collectingDeps(() =>
      streamOf(contentChunks(["Hel", "lo, ", "world"])),
    );
    const result = await runAgent(deps, REQ);

    const deltas = events.filter((e) => e.type === "content_delta");
    // The WIN: more than one delta for a multi-chunk answer.
    expect(deltas.length).toBeGreaterThan(1);
    const joined = deltas
      .map((e) => (e.type === "content_delta" ? e.text : ""))
      .join("");
    expect(joined).toBe("Hello, world");
    // Persisted content is byte-identical to the single-delta path.
    expect(result.message.content).toBe("Hello, world");
    expect(result.stop_reason).toBe("model_done");
    // Streaming was used — the blocking path never ran.
    expect(chat).not.toHaveBeenCalled();
    // Terminal `done` lands after the last content_delta.
    const doneIdx = events.findIndex((e) => e.type === "done");
    const lastDeltaIdx = events.map((e) => e.type).lastIndexOf("content_delta");
    expect(doneIdx).toBeGreaterThan(lastDeltaIdx);
  });

  it("the same tokens in ONE chunk still persist the same final content", async () => {
    const { deps, events } = collectingDeps(() =>
      streamOf(contentChunks(["Hello, world"])),
    );
    const result = await runAgent(deps, REQ);
    const joined = events
      .filter((e) => e.type === "content_delta")
      .map((e) => (e.type === "content_delta" ? e.text : ""))
      .join("");
    expect(joined).toBe("Hello, world");
    expect(result.message.content).toBe("Hello, world");
  });

  it("separates gpt-oss reasoning_content: reasoning_step BEFORE content, stripped from the answer", async () => {
    const { deps, events } = collectingDeps(() =>
      streamOf([
        { choices: [{ delta: { reasoning_content: "Think about " } }] },
        { choices: [{ delta: { reasoning_content: "the capital." } }] },
        { choices: [{ delta: { content: "Par" } }] },
        { choices: [{ delta: { content: "is." }, finish_reason: "stop" }] },
      ]),
    );
    const result = await runAgent(deps, { ...REQ, captureReasoning: true });

    const firstReasoning = events.findIndex((e) => e.type === "reasoning_step");
    const firstContent = events.findIndex((e) => e.type === "content_delta");
    expect(firstReasoning).toBeGreaterThanOrEqual(0);
    expect(firstReasoning).toBeLessThan(firstContent);

    const steps = events.filter((e) => e.type === "reasoning_step");
    expect(steps).toHaveLength(1);
    expect(steps[0].type === "reasoning_step" && steps[0].text).toBe(
      "Think about the capital.",
    );

    const answer = events
      .filter((e) => e.type === "content_delta")
      .map((e) => (e.type === "content_delta" ? e.text : ""))
      .join("");
    expect(answer).toBe("Paris.");
    expect(answer).not.toContain("Think");
    // Persisted trace + content match the non-streaming parser exactly.
    expect(result.message.reasoning).toBe("Think about the capital.");
    expect(result.message.content).toBe("Paris.");
  });

  it("does NOT emit reasoning_step on the wire when captureReasoning is false, but still persists it", async () => {
    const { deps, events } = collectingDeps(() =>
      streamOf([
        { choices: [{ delta: { reasoning_content: "Quiet thought." } }] },
        { choices: [{ delta: { content: "Answer." }, finish_reason: "stop" }] },
      ]),
    );
    const result = await runAgent(deps, { ...REQ, captureReasoning: false });
    expect(events.some((e) => e.type === "reasoning_step")).toBe(false);
    expect(result.message.reasoning).toBe("Quiet thought.");
    expect(result.message.content).toBe("Answer.");
  });

  it("strips harmony citation tokens from streamed content (WARP-1331), summing to the clean answer", async () => {
    const { deps, events } = collectingDeps(() =>
      streamOf(
        contentChunks([
          "The code is HMKQ8Z2T4F",
          "【3†source=search】",
          " and check-in is 15:00.",
        ]),
      ),
    );
    const result = await runAgent(deps, REQ);
    const answer = events
      .filter((e) => e.type === "content_delta")
      .map((e) => (e.type === "content_delta" ? e.text : ""))
      .join("");
    expect(answer).toContain("HMKQ8Z2T4F");
    expect(answer).toContain("15:00");
    expect(answer).not.toContain("【");
    expect(result.message.content).not.toContain("【");
    expect(result.message.content).toBe(answer);
  });

  it("accumulates streamed tool-call fragments BY INDEX into a valid call, then iterates", async () => {
    const callTool = vi.fn().mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ devices: [] }) }],
      isError: false,
    });
    const chatStream = vi
      .fn()
      // iteration 1: a tool call whose name + args arrive across chunks.
      .mockReturnValueOnce(
        streamOf([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "c1",
                      type: "function",
                      function: { name: "list_network_devices", arguments: "" },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] },
              },
            ],
          },
          {
            choices: [
              {
                delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] },
                finish_reason: "tool_calls",
              },
            ],
          },
        ]),
      )
      // iteration 2: the model answers.
      .mockReturnValueOnce(streamOf(contentChunks(["no devices"])));

    const { deps, events } = collectingDeps(chatStream, {
      callTool,
      tools: [
        {
          name: "list_network_devices",
          description: "...",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    const result = await runAgent(deps, {
      model: "gpt-oss:20b",
      messages: [{ role: "user", content: "show devices" }],
    });

    // The args fragments concatenated into one valid JSON object, parsed and
    // passed to the MCP child.
    expect(callTool).toHaveBeenCalledWith("list_network_devices", { a: 1 }, undefined);
    expect(result.iterations).toBe(2);
    expect(result.stop_reason).toBe("model_done");
    expect(result.message.content).toBe("no devices");
    // Same event contract: one tool_call, one tool_result, in order, then content.
    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(1);
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(1);
    const tcIdx = events.findIndex((e) => e.type === "tool_call");
    const trIdx = events.findIndex((e) => e.type === "tool_result");
    const cdIdx = events.findIndex((e) => e.type === "content_delta");
    expect(tcIdx).toBeLessThan(trIdx);
    expect(trIdx).toBeLessThan(cdIdx);
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0].tool).toBe("list_network_devices");
  });

  it("emits NO content_delta for an empty stream so WARP-854's rewrite still fires", async () => {
    const { deps, events } = collectingDeps(() =>
      streamOf([{ choices: [{ delta: {}, finish_reason: "stop" }] }]),
    );
    const result = await runAgent(deps, REQ);
    expect(result.stop_reason).toBe("model_done");
    expect(String(result.message.content).trim()).toBe("");
    expect(events.find((e) => e.type === "content_delta")).toBeUndefined();
    const done = events.find((e) => e.type === "done");
    expect(done && done.type === "done" && done.stop_reason).toBe("model_done");
  });

  it("demotes a streamed bare tool-args JSON answer to empty (WARP-854 failed turn)", async () => {
    const { deps, events } = collectingDeps(() =>
      streamOf(contentChunks(['{"path":', '"/Admin/IDs"}'])),
    );
    const result = await runAgent(deps, REQ);
    expect(String(result.message.content).trim()).toBe("");
    expect(events.find((e) => e.type === "content_delta")).toBeUndefined();
  });

  it("forwards reasoning_effort on the STREAMING request too (WARP-1442a)", async () => {
    const chatStream = vi.fn(
      (_req: { reasoning_effort?: string }, _signal?: AbortSignal) =>
        streamOf(contentChunks(["ok"])),
    );
    const { deps } = collectingDeps(chatStream);
    await runAgent(deps, { ...REQ, reasoning_effort: "low" });
    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(chatStream.mock.calls[0]![0]).toMatchObject({ reasoning_effort: "low" });
  });

  it("tears down the Ollama stream and returns the aborted terminal on mid-stream disconnect (WARP-329)", async () => {
    const controller = new AbortController();
    let tornDown = false;
    async function* gen(): AsyncGenerator<ChatStreamChunk> {
      try {
        yield { choices: [{ delta: { content: "Hel" } }] };
        // Client disconnects mid-generation.
        controller.abort();
        yield { choices: [{ delta: { content: "lo" } }] };
      } finally {
        // Runs when the `for await` loop breaks and calls .return() on us —
        // i.e. the upstream (Ollama) stream is torn down.
        tornDown = true;
      }
    }
    const chatStream = vi.fn(() => gen());
    const { deps } = collectingDeps(chatStream);
    const result = await runAgent(deps, { ...REQ, signal: controller.signal });
    expect(result.stop_reason).toBe("error");
    expect(result.error).toBe("client_aborted");
    expect(tornDown).toBe(true);
  });

  it("falls back to the blocking chat() when the streaming transport throws", async () => {
    const chat = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "fallback answer" } }],
      }),
    });
    const events: SSEEvent[] = [];
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([]),
        callTool: vi.fn(),
      } as never,
      aiGateway: {
        chat,
        chatStream: () => {
          throw new Error("stream transport down");
        },
      } as never,
      onEvent: (e: SSEEvent) => events.push(e),
    };
    const result = await runAgent(deps, REQ);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.message.content).toBe("fallback answer");
    expect(result.stop_reason).toBe("model_done");
    const deltas = events.filter((e) => e.type === "content_delta");
    expect(deltas).toHaveLength(1);
  });

  it("does NOT fall back (no double-emit) when the stream dies AFTER partial content", async () => {
    // Blocking chat would answer in full — falling back after partial content
    // was already streamed would replay + double the answer. Instead the turn
    // must surface an honest error and never touch chat().
    const chat = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          { message: { role: "assistant", content: "FULL BLOCKING ANSWER" } },
        ],
      }),
    });
    async function* dyingStream(): AsyncGenerator<ChatStreamChunk> {
      yield { choices: [{ delta: { content: "Partial" } }] };
      throw new Error("connection reset mid-stream");
    }
    const events: SSEEvent[] = [];
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([]),
        callTool: vi.fn(),
      } as never,
      aiGateway: { chat, chatStream: () => dyingStream() } as never,
      onEvent: (e: SSEEvent) => events.push(e),
    };
    const result = await runAgent(deps, REQ);

    expect(chat).not.toHaveBeenCalled();
    expect(result.stop_reason).toBe("error");
    expect(result.error).toBe("stream_interrupted");
    const joined = events
      .filter((e) => e.type === "content_delta")
      .map((e) => (e.type === "content_delta" ? e.text : ""))
      .join("");
    expect(joined).toBe("Partial");
    expect(joined).not.toContain("FULL BLOCKING");
    const done = events.find((e) => e.type === "done");
    expect(done && done.type === "done" && done.stop_reason).toBe("error");
  });

  it("uses the blocking path (no streaming) when onEvent is present but chatStream is absent", async () => {
    const chat = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "blocking" } }],
      }),
    });
    const events: SSEEvent[] = [];
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([]),
        callTool: vi.fn(),
      } as never,
      aiGateway: { chat } as never,
      onEvent: (e: SSEEvent) => events.push(e),
    };
    const result = await runAgent(deps, REQ);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.message.content).toBe("blocking");
    expect(events.filter((e) => e.type === "content_delta")).toHaveLength(1);
  });

  it("uses the blocking path when chatStream exists but the caller is NOT streaming (no onEvent)", async () => {
    const chat = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "blocking" } }],
      }),
    });
    const chatStream = vi.fn();
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([]),
        callTool: vi.fn(),
      } as never,
      aiGateway: { chat, chatStream } as never,
      // No onEvent → non-streaming caller.
    };
    const result = await runAgent(deps, REQ);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chatStream).not.toHaveBeenCalled();
    expect(result.message.content).toBe("blocking");
  });

  it("bails before opening a stream when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const chatStream = vi.fn();
    const { deps } = collectingDeps(chatStream);
    const result = await runAgent(deps, { ...REQ, signal: controller.signal });
    expect(chatStream).not.toHaveBeenCalled();
    expect(result.stop_reason).toBe("error");
    expect(result.error).toBe("client_aborted");
  });
});
