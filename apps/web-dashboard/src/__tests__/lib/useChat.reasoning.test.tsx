/**
 * WARP-458 front-end wiring — the dashboard finally consumes the
 * reasoning trace the backend has persisted all along:
 *   - every turn requests `captureReasoning: true`
 *   - `reasoning_step` SSE events accumulate onto the streaming
 *     assistant message's `reasoning` field
 *   - loadConversation carries the persisted trace through
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";

const mockSendChat = vi.fn();
const mockFetchConversation = vi.fn();
const mockGetBrainMemoryItems = vi.fn();
vi.mock("@/lib/api", () => ({
  sendChat: (...args: unknown[]) => mockSendChat(...args),
  uploadBrainFile: vi.fn(),
  fetchConversation: (...args: unknown[]) => mockFetchConversation(...args),
  getBrainMemoryItems: (...args: unknown[]) => mockGetBrainMemoryItems(...args),
}));

import { useChat } from "@/lib/hooks/useChat";

interface ProbeValue {
  messages: ReturnType<typeof useChat>["messages"];
  sendMessage: ReturnType<typeof useChat>["sendMessage"];
  loadConversation: ReturnType<typeof useChat>["loadConversation"];
}

function Probe({ onValue }: { onValue: (v: ProbeValue) => void }) {
  const hook = useChat();
  onValue({
    messages: hook.messages,
    sendMessage: hook.sendMessage,
    loadConversation: hook.loadConversation,
  });
  return null;
}

function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

beforeEach(() => {
  mockSendChat.mockReset();
  mockFetchConversation.mockReset();
  mockGetBrainMemoryItems.mockReset();
  mockGetBrainMemoryItems.mockResolvedValue({ items: [] });
});

describe("useChat — reasoning trace (WARP-458)", () => {
  it("requests captureReasoning on every turn", async () => {
    mockSendChat.mockResolvedValueOnce(
      sseResponse([
        `event: done\ndata: {"iterations":1,"stop_reason":"model_done"}\n\n`,
      ]),
    );
    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    await act(async () => {
      await probe!.sendMessage("hello", "m1");
    });

    expect(mockSendChat.mock.calls[0]![0]).toMatchObject({
      captureReasoning: true,
    });
  });

  it("accumulates reasoning_step events onto the assistant message", async () => {
    mockSendChat.mockResolvedValueOnce(
      sseResponse([
        `event: reasoning_step\ndata: {"text":"First I check the docs."}\n\n`,
        `event: reasoning_step\ndata: {"text":"Then I compare options."}\n\n`,
        `event: content_delta\ndata: {"text":"Answer."}\n\n`,
        `event: done\ndata: {"iterations":1,"stop_reason":"model_done"}\n\n`,
      ]),
    );
    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    await act(async () => {
      await probe!.sendMessage("why?", "m1");
    });

    const asst = probe!.messages.at(-1)!;
    expect(asst.role).toBe("assistant");
    expect(asst.content).toBe("Answer.");
    expect(asst.reasoning).toBe(
      "First I check the docs.\n\nThen I compare options.",
    );
  });

  it("carries the persisted reasoning through loadConversation", async () => {
    mockFetchConversation.mockResolvedValueOnce({
      id: "conv-r",
      title: "Why",
      model: "m1",
      provider: "ollama",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        {
          id: "m1",
          role: "user",
          content: "why?",
          toolCalls: null,
          toolCallId: null,
          turnId: "t1",
          createdAt: new Date().toISOString(),
        },
        {
          id: "m2",
          role: "assistant",
          content: "Answer.",
          reasoning: "Persisted trace.",
          toolCalls: null,
          toolCallId: null,
          turnId: "t1",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    await act(async () => {
      await probe!.loadConversation("conv-r");
    });

    expect(probe!.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Answer.",
      reasoning: "Persisted trace.",
    });
  });
});
