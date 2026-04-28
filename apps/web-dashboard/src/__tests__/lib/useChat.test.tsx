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

  it("surfaces a confirmation_required tool_result so the dashboard can render the Tier-2 modal", async () => {
    mockSendChat.mockResolvedValueOnce(
      sseResponse([
        `event: tool_call\ndata: ${JSON.stringify({
          id: "call-block",
          name: "block_network_device",
          args: { mac: "AA:BB:CC:DD:EE:FF" },
        })}\n\n`,
        `event: tool_result\ndata: ${JSON.stringify({
          id: "call-block",
          ok: false,
          status: "confirmation_required",
          message: "Confirm to apply",
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
      expect(last?.toolCalls?.[0].ok).toBe(false);
    });
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
