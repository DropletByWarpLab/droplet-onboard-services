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
 *
 * WARP-1602 adds the channel-discipline contract on top:
 *
 *   - a turn that ADVERTISED tools holds its content until its stop reason is
 *     known — released as the answer on a terminal turn, quarantined into the
 *     reasoning stream on a tool-call one, so analysis is never emitted as
 *     `content_delta` nor persisted as `content`;
 *   - a turn with ZERO tools cannot end in tool_calls, so it keeps streaming
 *     token-by-token (the WARP-1442 win, unchanged);
 *   - every intermediate step's thinking lands in `reasoningSteps` /
 *     `message.reasoning` with its per-step boundary intact;
 *   - the summed content_delta equals the persisted `message.content` on
 *     MULTI-iteration turns too, not just single ones.
 */
import { describe, it, expect, vi } from "vitest";
import {
  runAgent,
  REASONING_STEP_SEPARATOR,
  type AgentDeps,
} from "../services/llm-agent.service.js";
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

  it("streams inline <reasoning> (qwen3/deepseek): steps before content, stripped from the answer", async () => {
    // Inline-reasoning models emit <reasoning>…</reasoning> in the CONTENT
    // channel (not a separate field). Split the tags across chunks to prove the
    // emitter holds partial tags back and never leaks them into content_delta.
    const { deps, events } = collectingDeps(() =>
      streamOf(
        contentChunks([
          "<reason",
          "ing>Weigh the options.</reason",
          "ing>The ans",
          "wer is 42.",
        ]),
      ),
    );
    const result = await runAgent(deps, { ...REQ, captureReasoning: true });

    const steps = events.filter((e) => e.type === "reasoning_step");
    expect(steps).toHaveLength(1);
    expect(steps[0].type === "reasoning_step" && steps[0].text).toBe(
      "Weigh the options.",
    );
    const answer = events
      .filter((e) => e.type === "content_delta")
      .map((e) => (e.type === "content_delta" ? e.text : ""))
      .join("");
    expect(answer).toBe("The answer is 42.");
    // No reasoning tag/text leaked into the streamed content (WARP-495).
    expect(answer).not.toContain("<reasoning>");
    expect(answer).not.toContain("Weigh");
    // reasoning_step precedes the first content_delta (WARP-458).
    expect(events.findIndex((e) => e.type === "reasoning_step")).toBeLessThan(
      events.findIndex((e) => e.type === "content_delta"),
    );
    expect(result.message.content).toBe("The answer is 42.");
    expect(result.message.reasoning).toBe("Weigh the options.");
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

  // -- WARP-1602: content + tool_calls in the SAME turn is QUARANTINED --------
  //
  // This block replaces the WARP-1442-era "KNOWN DIVERGENCE" test, whose two
  // stated premises were both false and are deleted rather than re-pinned:
  //
  //   (a) "UNREACHABLE on the shipped path — gpt-oss puts tool calls on the
  //       commentary channel with an EMPTY final channel." A live row on the
  //       .87 box (gpt-oss:20b via ollama) carries multiple per-iteration
  //       analysis fragments concatenated into ChatMessage.content, so
  //       delta.content IS produced on tool-call turns. Harmony also documents
  //       preambles as an EXPECTED output class before a tool call, so
  //       content-then-tool_calls is normal model behaviour, not a hypothetical.
  //   (b) "a reload heals it." A reload re-reads the persisted column, which is
  //       where the polluted text lives — the reload showed the SAME fused text.
  //
  // The fix: a turn that advertised tools holds its content until its stop
  // reason is known, then either releases it (terminal answer) or quarantines
  // it into the reasoning stream (tool-call turn). The old objection — "a turn
  // is only known non-tool at its terminal chunk, so buffering regresses the
  // common turn" — is answered by scoping the hold to tool-ADVERTISING turns:
  // a zero-tool iteration cannot produce tool_calls, so it still streams
  // token-by-token (pinned by the very first test in this file).
  it("quarantines a preamble that precedes tool_calls: never content_delta, captured as reasoning", async () => {
    const callTool = vi.fn().mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ devices: [] }) }],
      isError: false,
    });
    const chatStream = vi
      .fn()
      // iteration 1: a content preamble, then a tool call, in one turn.
      .mockReturnValueOnce(
        streamOf([
          { choices: [{ delta: { content: "Let me check the network. " } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "c1",
                      type: "function",
                      function: { name: "list_network_devices", arguments: "{}" },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
        ]),
      )
      // iteration 2: the terminal answer.
      .mockReturnValueOnce(streamOf(contentChunks(["No devices found."])));

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
      captureReasoning: true,
    });

    // The tool still dispatches and the loop iterates: the tool path is intact.
    expect(callTool).toHaveBeenCalledWith("list_network_devices", {}, undefined);
    expect(result.stop_reason).toBe("model_done");

    // THE FIX: the preamble never reaches the wire as answer text…
    const streamed = events
      .filter((e) => e.type === "content_delta")
      .map((e) => (e.type === "content_delta" ? e.text : ""))
      .join("");
    expect(streamed).not.toContain("Let me check the network");
    // …the streamed answer now equals the persisted one EXACTLY (the
    // divergence this file used to document is gone)…
    expect(streamed).toBe("No devices found.");
    expect(result.message.content).toBe("No devices found.");
    expect(streamed).toBe(result.message.content);

    // …and it is not discarded either: it is this step's reasoning, on the
    // wire as a reasoning_step BEFORE the tool_call chip, and persisted.
    const stepIdx = events.findIndex(
      (e) => e.type === "reasoning_step" && e.text === "Let me check the network.",
    );
    const toolCallIdx = events.findIndex((e) => e.type === "tool_call");
    expect(stepIdx).toBeGreaterThanOrEqual(0);
    expect(stepIdx).toBeLessThan(toolCallIdx);
    expect(result.message.reasoning).toBe("Let me check the network.");
    expect(result.reasoningSteps).toEqual(["Let me check the network."]);
  });

  it("the live .87 shape: multi-iteration analysis never fuses into the answer, and reasoning is populated per step", async () => {
    // Reproduces the failing row: three iterations, each emitting its analysis
    // on delta.content, whose concatenation used to BE the persisted answer
    // ("…list files.Let's read csv.You spent €6 240…") with reasoning NULL.
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ files: [] }) }],
      isError: false,
    });
    const toolChunk = (id: string, name: string) => ({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id, type: "function" as const, function: { name, arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const chatStream = vi
      .fn()
      .mockReturnValueOnce(
        streamOf([
          {
            choices: [
              {
                delta: {
                  content:
                    'We need to answer "how much money did I spent in June?" ' +
                    "Likely refers to expenses. Let's look at Invoices folder: list files.",
                },
              },
            ],
          },
          toolChunk("c1", "list_files"),
        ]),
      )
      .mockReturnValueOnce(
        streamOf([
          { choices: [{ delta: { content: "Let's read csv." } }] },
          toolChunk("c2", "read_file"),
        ]),
      )
      .mockReturnValueOnce(
        streamOf(contentChunks(["You spent 6,240 EUR in June 2026."])),
      );

    const { deps, events } = collectingDeps(chatStream, {
      callTool,
      tools: [
        { name: "list_files", description: "...", inputSchema: { type: "object", properties: {} } },
        { name: "read_file", description: "...", inputSchema: { type: "object", properties: {} } },
      ],
    });
    const result = await runAgent(deps, {
      model: "gpt-oss:20b",
      messages: [{ role: "user", content: "how much money did I spend in June?" }],
      captureReasoning: true,
    });

    expect(result.iterations).toBe(3);
    // The answer is the terminal turn ALONE — no analysis, no run-on join.
    expect(result.message.content).toBe("You spent 6,240 EUR in June 2026.");
    expect(result.message.content).not.toContain("We need to answer");
    expect(result.message.content).not.toContain("Let's read csv");
    // What the client rendered is byte-identical to what was persisted.
    const streamed = events
      .filter((e) => e.type === "content_delta")
      .map((e) => (e.type === "content_delta" ? e.text : ""))
      .join("");
    expect(streamed).toBe(result.message.content);

    // The reasoning column is no longer NULL, and the per-step boundaries
    // survive flattening (WARP-1605 splits on REASONING_STEP_SEPARATOR).
    expect(result.reasoningSteps).toHaveLength(2);
    expect(result.reasoningSteps![0]).toContain("We need to answer");
    expect(result.reasoningSteps![1]).toBe("Let's read csv.");
    expect(result.message.reasoning).toBe(
      result.reasoningSteps!.join(REASONING_STEP_SEPARATOR),
    );
    expect(result.message.reasoning!.split(REASONING_STEP_SEPARATOR)).toHaveLength(2);

    // A clean answer trips no leak heuristic.
    expect(result.pollutedDiagnostics).toBeUndefined();
  });

  it("folds the gpt-oss reasoning channel of an INTERMEDIATE turn into the trace", async () => {
    // The reasoning channel on a tool-call turn used to be dropped on the
    // floor by both transports (WARP-495 parsed only the terminal turn).
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
      isError: false,
    });
    const chatStream = vi
      .fn()
      .mockReturnValueOnce(
        streamOf([
          { choices: [{ delta: { reasoning_content: "The invoices live in /Finance." } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "c1",
                      type: "function",
                      function: { name: "list_files", arguments: "{}" },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
        ]),
      )
      .mockReturnValueOnce(streamOf(contentChunks(["Two invoices."])));

    const { deps, events } = collectingDeps(chatStream, {
      callTool,
      tools: [
        { name: "list_files", description: "...", inputSchema: { type: "object", properties: {} } },
      ],
    });
    const result = await runAgent(deps, {
      model: "gpt-oss:20b",
      messages: [{ role: "user", content: "list invoices" }],
      captureReasoning: true,
    });

    expect(result.message.content).toBe("Two invoices.");
    expect(result.reasoningSteps).toEqual(["The invoices live in /Finance."]);
    expect(
      events.some(
        (e) => e.type === "reasoning_step" && e.text === "The invoices live in /Finance.",
      ),
    ).toBe(true);
  });

  it("suppresses intermediate reasoning on the wire when captureReasoning is false, but still persists it", async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
      isError: false,
    });
    const chatStream = vi
      .fn()
      .mockReturnValueOnce(
        streamOf([
          { choices: [{ delta: { content: "Checking the folder first." } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "c1",
                      type: "function",
                      function: { name: "list_files", arguments: "{}" },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
        ]),
      )
      .mockReturnValueOnce(streamOf(contentChunks(["Done."])));

    const { deps, events } = collectingDeps(chatStream, {
      callTool,
      tools: [
        { name: "list_files", description: "...", inputSchema: { type: "object", properties: {} } },
      ],
    });
    const result = await runAgent(deps, {
      model: "gpt-oss:20b",
      messages: [{ role: "user", content: "list invoices" }],
      captureReasoning: false,
    });

    expect(events.some((e) => e.type === "reasoning_step")).toBe(false);
    const streamed = events
      .filter((e) => e.type === "content_delta")
      .map((e) => (e.type === "content_delta" ? e.text : ""))
      .join("");
    expect(streamed).toBe("Done.");
    expect(result.message.content).toBe("Done.");
    expect(result.message.reasoning).toBe("Checking the folder first.");
  });

  it("attributes an answer that still opens with analysis prose (polluted-turn diagnostics)", async () => {
    // The inverse of WARP-1479's blank-turn attribution: a NON-empty answer
    // that is chain-of-thought must not score as healthy. Diagnostics only —
    // the answer itself is passed through untouched.
    const { deps } = collectingDeps(() =>
      streamOf(
        contentChunks([
          "We need to answer how much was spent. Let's look at Invoices: " +
            "list files.Let's read csv.You spent 6,240 EUR.",
        ]),
      ),
    );
    const result = await runAgent(deps, REQ);

    expect(result.pollutedDiagnostics).toBeDefined();
    expect(result.pollutedDiagnostics!.markers).toContain("first_person_plan");
    expect(result.pollutedDiagnostics!.markers).toContain("step_join_run_on");
    expect(result.pollutedDiagnostics!.transport).toBe("streaming");
    // Never a filter: the visible answer is unchanged.
    expect(result.message.content).toContain("You spent 6,240 EUR.");
  });

  it("leaves a healthy answer with no polluted diagnostics", async () => {
    const { deps } = collectingDeps(() =>
      streamOf(contentChunks(["You spent 6,240 EUR in June 2026."])),
    );
    const result = await runAgent(deps, REQ);
    expect(result.pollutedDiagnostics).toBeUndefined();
  });
});

// -- Byte-identity across EVERY chunk boundary (WARP-1442 invariant #1) -------
//
// The core contract: the streamed content_delta events MUST sum byte-for-byte
// to the single persisted message.content, no matter WHERE the token boundaries
// fall, including mid-word, mid-reasoning-tag, and mid-harmony-citation-token.
// This exhaustively splits each tricky answer at every 2-way cut point (plus a
// 3-way sweep) and asserts join(content_delta) equals the one-shot persisted
// content every time. A non-monotonic transform in the emitter (one that
// rewrites an already-emitted prefix) would surface here as a truncated or
// mismatched sum on some split.
describe("runAgent - streamed content_delta sums to message.content at every chunk boundary", () => {
  function splitAt(s: string, cuts: number[]): ChatStreamChunk[] {
    const bounds = [0, ...cuts, s.length];
    const parts: string[] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      parts.push(s.slice(bounds[i], bounds[i + 1]));
    }
    return contentChunks(parts);
  }

  async function joinDeltas(chunks: ChatStreamChunk[]) {
    const t = collectingDeps(() => streamOf(chunks));
    const r = await runAgent(t.deps, { ...REQ, captureReasoning: true });
    const joined = t.events
      .filter((e) => e.type === "content_delta")
      .map((e) => (e.type === "content_delta" ? e.text : ""))
      .join("");
    return { joined, content: r.message.content };
  }

  const OPEN = String.fromCharCode(0x3010);
  const CLOSE = String.fromCharCode(0x3011);
  const DAGGER = String.fromCharCode(0x2020);
  const tok = (n: string, s: string) => OPEN + n + DAGGER + "source=" + s + CLOSE;

  const RAWS: Array<{ label: string; raw: string }> = [
    { label: "collapsing double space", raw: "Hello,  world!  Nice  day." },
    { label: "3+ newline collapse", raw: "Para one.\n\n\n\nPara two." },
    { label: "single harmony token", raw: "The code is " + tok("3", "kb") + " confirmed." },
    { label: "two harmony tokens", raw: "See " + tok("1", "a") + " and " + tok("2", "b") + " end." },
    { label: "inline reasoning strip", raw: "Before <reasoning>hidden</reasoning> after." },
    { label: "multi inline reasoning", raw: "A <reasoning>one</reasoning> B <reasoning>two</reasoning> C." },
    { label: "leading+trailing space", raw: "   padded on both sides   " },
    { label: "reasoning then harmony", raw: "X <reasoning>r</reasoning> Y " + tok("9", "z") + " Z." },
  ];

  for (const { label, raw } of RAWS) {
    it(`sums correctly for: ${label}`, async () => {
      const base = await joinDeltas(contentChunks([raw]));
      const expected = base.content;
      expect(base.joined).toBe(expected);

      for (let i = 1; i < raw.length; i++) {
        const { joined, content } = await joinDeltas(splitAt(raw, [i]));
        expect(joined, `2-way cut @${i}`).toBe(expected);
        expect(content, `persist @${i}`).toBe(expected);
      }

      for (let i = 1; i < raw.length - 1; i += 3) {
        for (let j = i + 1; j < raw.length; j += 3) {
          const { joined, content } = await joinDeltas(splitAt(raw, [i, j]));
          expect(joined, `3-way cut @${i},${j}`).toBe(expected);
          expect(content, `persist @${i},${j}`).toBe(expected);
        }
      }
    });
  }
});

