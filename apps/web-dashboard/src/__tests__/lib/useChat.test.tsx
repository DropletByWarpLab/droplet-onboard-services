import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";

// Hoisted mock — `vi.mock` runs before imports, so the mock factory must
// not close over module-scope variables. We expose the mocked fn through
// a getter that pulls a fresh reference each test.
const mockSendChat = vi.fn();
vi.mock("@/lib/api", () => ({
  sendChat: (...args: unknown[]) => mockSendChat(...args),
}));

import { useChat } from "@/lib/hooks/useChat";

interface ProbeValue {
  messages: ReturnType<typeof useChat>["messages"];
  isStreaming: boolean;
  sendMessage: ReturnType<typeof useChat>["sendMessage"];
  retryMessage: ReturnType<typeof useChat>["retryMessage"];
  clearMessages: ReturnType<typeof useChat>["clearMessages"];
}

function Probe({
  onValue,
}: {
  onValue: (v: ProbeValue) => void;
}) {
  const hook = useChat();
  onValue({
    messages: hook.messages,
    isStreaming: hook.isStreaming,
    sendMessage: hook.sendMessage,
    retryMessage: hook.retryMessage,
    clearMessages: hook.clearMessages,
  });
  return null;
}

/**
 * Build a `Response` whose `body` streams the given SSE frames in order.
 * Mirrors the orchestrator's `encodeSSE()` shape (`event: <type>\ndata: <json>\n\n`).
 */
function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("useChat (MCP-backed /api/llm/chat)", () => {
  let value: ProbeValue | null = null;

  beforeEach(() => {
    value = null;
    mockSendChat.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls sendChat (not sendSessionChat) on the first user turn", async () => {
    mockSendChat.mockResolvedValueOnce(
      sseResponse([
        `event: content_delta\ndata: ${JSON.stringify({ text: "ok" })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ iterations: 1, stop_reason: "model_done" })}\n\n`,
      ]),
    );

    render(<Probe onValue={(v) => (value = v)} />);
    expect(value).not.toBeNull();

    await act(async () => {
      await value!.sendMessage("hello", "llama3:8b");
    });

    expect(mockSendChat).toHaveBeenCalledOnce();
    const call = mockSendChat.mock.calls[0][0] as {
      model: string;
      messages: { role: string; content: string }[];
      stream: boolean;
    };
    expect(call.model).toBe("llama3:8b");
    expect(call.stream).toBe(true);
    expect(call.messages.at(-1)).toEqual({ role: "user", content: "hello" });
  });

  // ── WARP-904: per-turn provider/model quick-switch ──

  it("forwards an explicit provider when the caller supplies one", async () => {
    mockSendChat.mockResolvedValueOnce(
      sseResponse([
        `event: content_delta\ndata: ${JSON.stringify({ text: "ok" })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ iterations: 1, stop_reason: "model_done" })}\n\n`,
      ]),
    );

    render(<Probe onValue={(v) => (value = v)} />);

    await act(async () => {
      await value!.sendMessage("hello", "claude-sonnet-4-20250514", undefined, "anthropic");
    });

    const call = mockSendChat.mock.calls[0][0] as { provider?: string };
    expect(call.provider).toBe("anthropic");
  });

  it("omits the provider field entirely when the caller doesn't supply one (back-compat)", async () => {
    mockSendChat.mockResolvedValueOnce(
      sseResponse([
        `event: content_delta\ndata: ${JSON.stringify({ text: "ok" })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ iterations: 1, stop_reason: "model_done" })}\n\n`,
      ]),
    );

    render(<Probe onValue={(v) => (value = v)} />);

    await act(async () => {
      await value!.sendMessage("hello", "llama3:8b");
    });

    const call = mockSendChat.mock.calls[0][0] as Record<string, unknown>;
    expect("provider" in call).toBe(false);
  });

  it("accumulates content_delta events into the streaming assistant message", async () => {
    mockSendChat.mockResolvedValueOnce(
      sseResponse([
        `event: content_delta\ndata: ${JSON.stringify({ text: "Hel" })}\n\n`,
        `event: content_delta\ndata: ${JSON.stringify({ text: "lo " })}\n\n`,
        `event: content_delta\ndata: ${JSON.stringify({ text: "world" })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ iterations: 1, stop_reason: "model_done" })}\n\n`,
      ]),
    );

    render(<Probe onValue={(v) => (value = v)} />);

    await act(async () => {
      await value!.sendMessage("hi", "llama3:8b");
    });

    await waitFor(() => {
      const last = value!.messages.at(-1);
      expect(last?.role).toBe("assistant");
      expect(last?.content).toBe("Hello world");
    });
    expect(value!.isStreaming).toBe(false);
  });

  it("renders tool_call / tool_result events as inline chips on the assistant message", async () => {
    mockSendChat.mockResolvedValueOnce(
      sseResponse([
        `event: tool_call\ndata: ${JSON.stringify({
          id: "call-1",
          name: "list_network_devices",
          args: {},
        })}\n\n`,
        `event: tool_result\ndata: ${JSON.stringify({
          id: "call-1",
          ok: true,
          data: { devices: [] },
        })}\n\n`,
        `event: content_delta\ndata: ${JSON.stringify({ text: "Done." })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ iterations: 1, stop_reason: "model_done" })}\n\n`,
      ]),
    );

    render(<Probe onValue={(v) => (value = v)} />);

    await act(async () => {
      await value!.sendMessage("what's connected?", "llama3:8b");
    });

    await waitFor(() => {
      const last = value!.messages.at(-1);
      expect(last?.role).toBe("assistant");
      expect(last?.content).toBe("Done.");
      expect(last?.toolCalls).toEqual([
        {
          id: "call-1",
          name: "list_network_devices",
          args: {},
          ok: true,
          data: { devices: [] },
        },
      ]);
    });
  });

  it("surfaces confirmation_required (per spec §8.2: ok=true, status='confirmation_required') so the dashboard can render the approval chip", async () => {
    // Spec §7.1 + §8.2: confirmation_required is NOT an MCP hard error
    // (isError: false), so the SSE wire shape is `ok: true` paired with
    // `status: "confirmation_required"`. The orchestrator's runAgent at
    // llm-agent.service.ts:153 emits this exact shape with a comment
    // "NOT a hard error from the model's perspective". The dashboard
    // chip's discriminator is `status` only, NOT `ok`.
    mockSendChat.mockResolvedValueOnce(
      sseResponse([
        `event: tool_call\ndata: ${JSON.stringify({
          id: "call-block",
          name: "block_network_device",
          args: { mac: "AA:BB:CC:DD:EE:FF" },
        })}\n\n`,
        `event: tool_result\ndata: ${JSON.stringify({
          id: "call-block",
          ok: true, // ← matches MCP isError:false per spec §7.1
          status: "confirmation_required",
          message: "Open the dashboard to approve",
        })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ iterations: 1, stop_reason: "model_done" })}\n\n`,
      ]),
    );

    render(<Probe onValue={(v) => (value = v)} />);

    await act(async () => {
      await value!.sendMessage("block AA:BB:CC:DD:EE:FF", "llama3:8b");
    });

    await waitFor(() => {
      const last = value!.messages.at(-1);
      expect(last?.toolCalls?.[0].status).toBe("confirmation_required");
      // The wire shape carries ok:true. The chip uses `status` as the
      // discriminator so this branch reaches the amber confirmation
      // visual rather than the green "success" check.
      expect(last?.toolCalls?.[0].ok).toBe(true);
      expect(last?.toolCalls?.[0].message).toBe("Open the dashboard to approve");
    });
  });

  it("on a fetch failure, marks the assistant turn with an error + retryPrompt (no raw error string in content)", async () => {
    mockSendChat.mockRejectedValueOnce(new Error("Failed to fetch"));

    render(<Probe onValue={(v) => (value = v)} />);

    await act(async () => {
      await value!.sendMessage("hello", "llama3:8b");
    });

    await waitFor(() => {
      const last = value!.messages.at(-1);
      expect(last?.role).toBe("assistant");
      // Friendly copy, not the raw "Failed to fetch" string.
      expect(last?.content).toBe("");
      expect(last?.error).toBeDefined();
      expect(last?.error?.message).toMatch(/Droplet|connection|Try again/i);
      expect(last?.error?.message).not.toMatch(/Failed to fetch/);
      expect(last?.error?.retryPrompt).toBe("hello");
    });
  });

  it("retryMessage drops the failed turn + its user prompt and re-sends with a clean replay", async () => {
    // First turn fails.
    mockSendChat.mockRejectedValueOnce(new Error("Failed to fetch"));
    // Second turn (the retry) succeeds.
    mockSendChat.mockResolvedValueOnce(
      sseResponse([
        `event: content_delta\ndata: ${JSON.stringify({ text: "Retry succeeded." })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ iterations: 1, stop_reason: "model_done" })}\n\n`,
      ]),
    );

    render(<Probe onValue={(v) => (value = v)} />);

    await act(async () => {
      await value!.sendMessage("hello", "llama3:8b");
    });

    await waitFor(() => {
      const errorMsg = value!.messages.at(-1);
      expect(errorMsg?.error).toBeDefined();
    });

    const failedId = value!.messages.at(-1)!.id;

    // Retry — the page wires retryMessage to onRetry on the chip.
    await act(async () => {
      await value!.retryMessage(failedId, "llama3:8b");
    });

    // After retry settles, sendChat should have been called twice.
    expect(mockSendChat).toHaveBeenCalledTimes(2);

    await waitFor(() => {
      const last = value!.messages.at(-1);
      expect(last?.role).toBe("assistant");
      expect(last?.content).toBe("Retry succeeded.");
      expect(last?.error).toBeUndefined();
    });

    // The replayed thread should NOT include the failed assistant turn —
    // verify by inspecting the second sendChat call's messages payload.
    expect(mockSendChat).toHaveBeenCalledTimes(2);
    const secondCallArgs = mockSendChat.mock.calls[1][0] as {
      messages: { role: string; content: string }[];
    };
    // Should be a single user turn replayed (the retried prompt) — no
    // empty/error assistant turns sneaking in.
    expect(secondCallArgs.messages).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  it("retryMessage carries the prompt + prior history in the request body AT CALL TIME (serialization snapshot)", async () => {
    // Production `sendChat` JSON.stringify()s the body synchronously the
    // moment it's called — the wire carries whatever `messages` holds at
    // that instant. The reference-based assertion in the test above can't
    // see this (the mock keeps the array by reference and the deferred
    // setMessages updater back-fills it before the assertion runs), so
    // snapshot the payload inside the mock, exactly like the serializer.
    const callTimeMessages: { role: string; content: string }[][] = [];
    const snapshot = (req: unknown) => {
      const r = req as { messages: { role: string; content: string }[] };
      callTimeMessages.push(JSON.parse(JSON.stringify(r.messages)));
    };
    // Turn 1 succeeds, turn 2 fails, turn 3 is the retry of turn 2.
    mockSendChat.mockImplementationOnce(async (req: unknown) => {
      snapshot(req);
      return sseResponse([
        `event: content_delta\ndata: ${JSON.stringify({ text: "Hello!" })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ iterations: 1, stop_reason: "model_done" })}\n\n`,
      ]);
    });
    mockSendChat.mockImplementationOnce(async (req: unknown) => {
      snapshot(req);
      throw new Error("Failed to fetch");
    });
    mockSendChat.mockImplementationOnce(async (req: unknown) => {
      snapshot(req);
      return sseResponse([
        `event: content_delta\ndata: ${JSON.stringify({ text: "3 devices online." })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ iterations: 1, stop_reason: "model_done" })}\n\n`,
      ]);
    });

    render(<Probe onValue={(v) => (value = v)} />);

    await act(async () => {
      await value!.sendMessage("hi", "llama3:8b");
    });
    await act(async () => {
      await value!.sendMessage("show devices", "llama3:8b");
    });

    await waitFor(() => {
      expect(value!.messages.at(-1)?.error).toBeDefined();
    });
    const failedId = value!.messages.at(-1)!.id;

    await act(async () => {
      await value!.retryMessage(failedId, "llama3:8b");
    });

    expect(mockSendChat).toHaveBeenCalledTimes(3);
    // The retry request must replay the surviving history AND the retried
    // prompt at the moment the request is serialized — an empty (or
    // prompt-less) payload here is exactly the "LLM answers a generic
    // greeting on every retry" bug.
    expect(callTimeMessages[2]).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "show devices" },
    ]);
  });

  it("surfaces the orchestrator's 400 empty_replay rejection with its own copy", async () => {
    // Server-side backstop for the empty-thread replay bug this branch
    // fixes: the orchestrator now rejects a user-turn-less `messages`
    // array with 400 { error: "empty_replay" } (routes/llm.ts) instead of
    // running the agent loop on a blank thread. That rejection must reach
    // the user as a distinct, actionable error bubble — not the generic
    // fallback — so a future serialization regression is recognizable.
    mockSendChat.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "empty_replay" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(<Probe onValue={(v) => (value = v)} />);

    await act(async () => {
      await value!.sendMessage("hello", "llama3:8b");
    });

    await waitFor(() => {
      expect(value!.messages.at(-1)?.error).toBeDefined();
    });
    expect(value!.messages.at(-1)!.error!.message).toBe(
      "The app sent an empty conversation, so the AI had nothing to answer. Refresh the page and try again.",
    );
  });

  it("done event with stop_reason='error' marks the assistant turn as an error with retryPrompt", async () => {
    mockSendChat.mockResolvedValueOnce(
      sseResponse([
        `event: done\ndata: ${JSON.stringify({
          iterations: 5,
          stop_reason: "error",
          error: "ai-gateway 503",
        })}\n\n`,
      ]),
    );

    render(<Probe onValue={(v) => (value = v)} />);

    await act(async () => {
      await value!.sendMessage("show devices", "llama3:8b");
    });

    await waitFor(() => {
      const last = value!.messages.at(-1);
      expect(last?.role).toBe("assistant");
      expect(last?.content).toBe("");
      expect(last?.error).toBeDefined();
      // Friendly copy, not the raw "ai-gateway 503" string.
      expect(last?.error?.message).not.toMatch(/503|ai-gateway/);
      expect(last?.error?.retryPrompt).toBe("show devices");
    });
  });

  it("done event with stop_reason='error' AFTER partial content keeps content + sets error (failed), not failureKind", async () => {
    // Backend fails mid-turn: some content already streamed, then `done`
    // arrives with stop_reason="error". The live path sets `error` (the
    // FailureChip derives "failed" → live retry copy) and must NOT set
    // `failureKind`, which per the types.ts contract is populated
    // exclusively by loadConversation (DASH-03). Partial content is kept.
    mockSendChat.mockResolvedValueOnce(
      sseResponse([
        `event: content_delta\ndata: ${JSON.stringify({ text: "Here is the start of the ans" })}\n\n`,
        `event: done\ndata: ${JSON.stringify({
          iterations: 3,
          stop_reason: "error",
          error: "ai-gateway 503",
        })}\n\n`,
      ]),
    );

    render(<Probe onValue={(v) => (value = v)} />);

    await act(async () => {
      await value!.sendMessage("write me a summary", "llama3:8b");
    });

    await waitFor(() => {
      const last = value!.messages.at(-1);
      expect(last?.role).toBe("assistant");
      // Partial content is preserved verbatim.
      expect(last?.content).toBe("Here is the start of the ans");
      // Live turns never set failureKind — it derives to "failed" from error.
      expect(last?.failureKind).toBeUndefined();
      // error carries the retryPrompt so the chip's "Try again" re-sends.
      expect(last?.error).toBeDefined();
      expect(last?.error?.retryPrompt).toBe("write me a summary");
      // Friendly copy, never the raw backend string.
      expect(last?.error?.message).not.toMatch(/503|ai-gateway/);
    });
    expect(value!.isStreaming).toBe(false);
  });

  it("clearMessages wipes the rolling thread", async () => {
    mockSendChat.mockResolvedValueOnce(
      sseResponse([
        `event: content_delta\ndata: ${JSON.stringify({ text: "ok" })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ iterations: 1, stop_reason: "model_done" })}\n\n`,
      ]),
    );

    render(<Probe onValue={(v) => (value = v)} />);

    await act(async () => {
      await value!.sendMessage("hi", "llama3:8b");
    });
    expect(value!.messages.length).toBeGreaterThan(0);

    act(() => value!.clearMessages());
    expect(value!.messages).toEqual([]);
  });
});
