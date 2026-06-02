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

  it("done event with stop_reason='error' AFTER partial content marks the turn interrupted (so the FailureChip + retry render)", async () => {
    // Backend fails mid-turn: some content already streamed, then `done`
    // arrives with stop_reason="error". Previously this returned the
    // message unchanged → a silently truncated answer with no retry.
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
      // failureKind drives the partial-ellipsis + FailureChip render.
      expect(last?.failureKind).toBe("interrupted");
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
