/**
 * WARP-304 — `useChat` tracks the server-assigned `conversationId` and
 * supports loading a persisted conversation by id.
 *
 * Verified:
 *   - first turn captures the `X-Conversation-Id` response header
 *   - subsequent turns forward the same id + a fresh `turnId`
 *   - `clearMessages()` resets the id (new chat severs persistence link)
 *   - `loadConversation(id)` rehydrates messages from the server payload
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";

const mockSendChat = vi.fn();
const mockFetchConversation = vi.fn();
vi.mock("@/lib/api", () => ({
  sendChat: (...args: unknown[]) => mockSendChat(...args),
  uploadBrainFile: vi.fn(),
  fetchConversation: (...args: unknown[]) => mockFetchConversation(...args),
}));

import { useChat } from "@/lib/hooks/useChat";

interface ProbeValue {
  messages: ReturnType<typeof useChat>["messages"];
  sendMessage: ReturnType<typeof useChat>["sendMessage"];
  clearMessages: ReturnType<typeof useChat>["clearMessages"];
  loadConversation: ReturnType<typeof useChat>["loadConversation"];
  retryMessage: ReturnType<typeof useChat>["retryMessage"];
  conversationId: string | null;
}

function Probe({ onValue }: { onValue: (v: ProbeValue) => void }) {
  const hook = useChat();
  onValue({
    messages: hook.messages,
    sendMessage: hook.sendMessage,
    clearMessages: hook.clearMessages,
    loadConversation: hook.loadConversation,
    retryMessage: hook.retryMessage,
    conversationId: hook.conversationId,
  });
  return null;
}

/** Build an SSE response that ends immediately. Streams just one `done`. */
function quickSseResponse(conversationId: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      c.enqueue(enc.encode(`event: done\ndata: {"iterations":1,"stop_reason":"model_done"}\n\n`));
      c.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "X-Conversation-Id": conversationId,
    },
  });
}

describe("useChat — conversation persistence (WARP-304)", () => {
  beforeEach(() => {
    mockSendChat.mockReset();
    mockFetchConversation.mockReset();
  });

  it("captures the X-Conversation-Id header on the first turn", async () => {
    mockSendChat.mockResolvedValueOnce(quickSseResponse("conv-abc"));

    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    await act(async () => {
      await probe!.sendMessage("hello", "llama3");
    });

    await waitFor(() => {
      expect(probe!.conversationId).toBe("conv-abc");
    });
  });

  it("forwards conversationId on subsequent turns and mints a fresh turnId each time", async () => {
    mockSendChat
      .mockResolvedValueOnce(quickSseResponse("conv-xyz"))
      .mockResolvedValueOnce(quickSseResponse("conv-xyz"));

    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    await act(async () => {
      await probe!.sendMessage("first", "llama3");
    });
    await waitFor(() => expect(probe!.conversationId).toBe("conv-xyz"));

    await act(async () => {
      await probe!.sendMessage("second", "llama3");
    });

    expect(mockSendChat).toHaveBeenCalledTimes(2);
    const firstCallArgs = mockSendChat.mock.calls[0][0];
    const secondCallArgs = mockSendChat.mock.calls[1][0];

    // First turn: no conversationId (server mints one).
    expect(firstCallArgs.conversationId).toBeUndefined();
    // Second turn: re-uses the id captured from the header.
    expect(secondCallArgs.conversationId).toBe("conv-xyz");
    // Each turn gets its own turnId.
    expect(firstCallArgs.turnId).toBeDefined();
    expect(secondCallArgs.turnId).toBeDefined();
    expect(firstCallArgs.turnId).not.toBe(secondCallArgs.turnId);
  });

  it("clearMessages resets conversationId so the next turn starts fresh", async () => {
    mockSendChat
      .mockResolvedValueOnce(quickSseResponse("conv-one"))
      .mockResolvedValueOnce(quickSseResponse("conv-two"));

    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    await act(async () => {
      await probe!.sendMessage("first", "llama3");
    });
    await waitFor(() => expect(probe!.conversationId).toBe("conv-one"));

    act(() => {
      probe!.clearMessages();
    });
    expect(probe!.conversationId).toBeNull();

    await act(async () => {
      await probe!.sendMessage("after new chat", "llama3");
    });
    // Server returned a fresh id; client picks it up.
    await waitFor(() => expect(probe!.conversationId).toBe("conv-two"));
    // The second send went out with NO conversationId (because we cleared).
    expect(mockSendChat.mock.calls[1][0].conversationId).toBeUndefined();
  });

  it("loadConversation populates messages and pins the conversationId", async () => {
    mockFetchConversation.mockResolvedValueOnce({
      id: "conv-loaded",
      title: "Plan dinner",
      model: "llama3",
      provider: "ollama",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        {
          id: "m1",
          role: "user",
          content: "ping",
          toolCalls: null,
          toolCallId: null,
          turnId: "t1",
          createdAt: new Date().toISOString(),
        },
        {
          id: "m2",
          role: "assistant",
          content: "pong",
          toolCalls: [{ id: "c1", name: "get_time", args: {} }],
          toolCallId: null,
          turnId: "t1",
          createdAt: new Date().toISOString(),
        },
        {
          // tool/system roles dropped from the user-visible thread
          id: "m3",
          role: "tool",
          content: "{}",
          toolCalls: null,
          toolCallId: "c1",
          turnId: "t1",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    let ok: boolean | undefined;
    await act(async () => {
      ok = await probe!.loadConversation("conv-loaded");
    });

    expect(ok).toBe(true);
    expect(probe!.conversationId).toBe("conv-loaded");
    expect(probe!.messages).toHaveLength(2);
    expect(probe!.messages[0]).toMatchObject({ role: "user", content: "ping" });
    expect(probe!.messages[1]).toMatchObject({ role: "assistant", content: "pong" });
    expect(probe!.messages[1].toolCalls?.[0]).toMatchObject({ id: "c1", name: "get_time" });
  });

  it("loadConversation maps server status to failureKind on assistant messages", async () => {
    mockFetchConversation.mockResolvedValueOnce({
      id: "conv-statuses",
      title: "Various failures",
      model: "llama3",
      provider: "ollama",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        { id: "u1", role: "user", content: "ok turn", toolCalls: null, toolCallId: null, turnId: "t1", status: "completed", createdAt: new Date().toISOString() },
        { id: "a1", role: "assistant", content: "fine", toolCalls: null, toolCallId: null, turnId: "t1", status: "completed", createdAt: new Date().toISOString() },
        { id: "u2", role: "user", content: "boom turn", toolCalls: null, toolCallId: null, turnId: "t2", status: "completed", createdAt: new Date().toISOString() },
        { id: "a2", role: "assistant", content: "", toolCalls: null, toolCallId: null, turnId: "t2", status: "failed", createdAt: new Date().toISOString() },
        { id: "u3", role: "user", content: "stop turn", toolCalls: null, toolCallId: null, turnId: "t3", status: "completed", createdAt: new Date().toISOString() },
        { id: "a3", role: "assistant", content: "partial", toolCalls: null, toolCallId: null, turnId: "t3", status: "aborted", createdAt: new Date().toISOString() },
        { id: "u4", role: "user", content: "crash turn", toolCalls: null, toolCallId: null, turnId: "t4", status: "completed", createdAt: new Date().toISOString() },
        { id: "a4", role: "assistant", content: "mid", toolCalls: null, toolCallId: null, turnId: "t4", status: "streaming", createdAt: new Date().toISOString() },
      ],
    });

    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    await act(async () => {
      await probe!.loadConversation("conv-statuses");
    });

    expect(probe!.messages).toHaveLength(8);
    expect(probe!.messages[1]).toMatchObject({ id: "a1" });
    expect(probe!.messages[1].failureKind).toBeUndefined();
    expect(probe!.messages[3]).toMatchObject({ id: "a2", failureKind: "failed" });
    expect(probe!.messages[5]).toMatchObject({
      id: "a3",
      failureKind: "aborted",
      content: "partial",
    });
    expect(probe!.messages[7]).toMatchObject({
      id: "a4",
      failureKind: "interrupted",
      content: "mid",
    });
  });

  it("loadConversation synthesizes a missing-reply placeholder for a tail-orphan user message", async () => {
    mockFetchConversation.mockResolvedValueOnce({
      id: "conv-orphan",
      title: "Orphan",
      model: "llama3",
      provider: "ollama",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        { id: "u1", role: "user", content: "first", toolCalls: null, toolCallId: null, turnId: "t1", status: "completed", createdAt: new Date().toISOString() },
        { id: "a1", role: "assistant", content: "reply", toolCalls: null, toolCallId: null, turnId: "t1", status: "completed", createdAt: new Date().toISOString() },
        { id: "u2", role: "user", content: "no reply ever came", toolCalls: null, toolCallId: null, turnId: "t2", status: "completed", createdAt: new Date().toISOString() },
      ],
    });

    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    await act(async () => {
      await probe!.loadConversation("conv-orphan");
    });

    expect(probe!.messages).toHaveLength(4);
    expect(probe!.messages[3]).toMatchObject({
      id: "missing-after-u2",
      role: "assistant",
      content: "",
      failureKind: "missing",
    });
  });

  it("loadConversation does NOT synthesize a placeholder for a mid-conversation orphan", async () => {
    // user → user → assistant: the first orphan is mid-stream. Per spec
    // we only synthesize for TAIL orphans.
    mockFetchConversation.mockResolvedValueOnce({
      id: "conv-mid-orphan",
      title: "Mid orphan",
      model: "llama3",
      provider: "ollama",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        { id: "u1", role: "user", content: "first", toolCalls: null, toolCallId: null, turnId: "t1", status: "completed", createdAt: new Date().toISOString() },
        { id: "u2", role: "user", content: "second", toolCalls: null, toolCallId: null, turnId: "t2", status: "completed", createdAt: new Date().toISOString() },
        { id: "a2", role: "assistant", content: "reply", toolCalls: null, toolCallId: null, turnId: "t2", status: "completed", createdAt: new Date().toISOString() },
      ],
    });

    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    await act(async () => {
      await probe!.loadConversation("conv-mid-orphan");
    });

    expect(probe!.messages).toHaveLength(3);
    expect(probe!.messages.find((m) => m.failureKind === "missing")).toBeUndefined();
  });

  it("retryMessage drops the failed assistant + preceding user and re-sends, using failureKind-derived prompt", async () => {
    mockFetchConversation.mockResolvedValueOnce({
      id: "conv-retry",
      title: "Retry me",
      model: "llama3",
      provider: "ollama",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        { id: "u1", role: "user", content: "the original prompt", toolCalls: null, toolCallId: null, turnId: "t1", status: "completed", createdAt: new Date().toISOString() },
        { id: "a1", role: "assistant", content: "", toolCalls: null, toolCallId: null, turnId: "t1", status: "failed", createdAt: new Date().toISOString() },
      ],
    });
    // sendChat returns a stream that ends immediately so retry resolves.
    mockSendChat.mockResolvedValue({
      headers: new Headers({ "x-conversation-id": "conv-retry" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(`event: done\ndata: {"iterations":1,"stop_reason":"model_done"}\n\n`),
          );
          controller.close();
        },
      }),
    });

    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    await act(async () => {
      await probe!.loadConversation("conv-retry");
    });

    expect(probe!.messages[1].failureKind).toBe("failed");

    await act(async () => {
      await probe!.retryMessage("a1", "llama3");
    });

    expect(mockSendChat).toHaveBeenCalledTimes(1);
    const sendArgs = mockSendChat.mock.calls[0][0];
    // The replay messages should END with the re-sent user turn —
    // confirming we derived the prompt from u1.
    expect(sendArgs.messages.at(-1)).toEqual({
      role: "user",
      content: "the original prompt",
    });
  });

  it("loadConversation returns false when the server has no such conversation", async () => {
    mockFetchConversation.mockResolvedValueOnce(null);

    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    let ok: boolean | undefined;
    await act(async () => {
      ok = await probe!.loadConversation("conv-missing");
    });
    expect(ok).toBe(false);
    expect(probe!.conversationId).toBeNull();
    expect(probe!.messages).toHaveLength(0);
  });
});
