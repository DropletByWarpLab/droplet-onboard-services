/**
 * WARP-844 — edit & resend a user turn.
 *
 * Honest persistence: before re-sending the edited prompt, the hook
 * truncates the persisted thread from the edited message onward (the
 * orchestrator's DELETE /llm/conversations/:id/messages/:messageId),
 * so a reload shows exactly what the user sees. The user bubble's id is
 * the SERVER row id (captured from the X-User-Message-Id response
 * header on send), which is what makes the truncation call possible on
 * live threads.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";

const mockSendChat = vi.fn();
const mockTruncateConversation = vi.fn();
const mockSetMessageFeedback = vi.fn();
vi.mock("@/lib/api", () => ({
  sendChat: (...a: unknown[]) => mockSendChat(...a),
  uploadBrainFile: vi.fn(),
  fetchConversation: vi.fn(),
  getBrainMemoryItems: vi.fn().mockResolvedValue({ items: [] }),
  truncateConversation: (...a: unknown[]) => mockTruncateConversation(...a),
  setMessageFeedback: (...a: unknown[]) => mockSetMessageFeedback(...a),
}));

import { useChat } from "@/lib/hooks/useChat";

interface ProbeValue {
  messages: ReturnType<typeof useChat>["messages"];
  sendMessage: ReturnType<typeof useChat>["sendMessage"];
  editMessage: ReturnType<typeof useChat>["editMessage"];
  rateMessage: ReturnType<typeof useChat>["rateMessage"];
  clearMessages: ReturnType<typeof useChat>["clearMessages"];
}

function Probe({ onValue }: { onValue: (v: ProbeValue) => void }) {
  const hook = useChat();
  onValue({
    messages: hook.messages,
    sendMessage: hook.sendMessage,
    editMessage: hook.editMessage,
    rateMessage: hook.rateMessage,
    clearMessages: hook.clearMessages,
  });
  return null;
}

function sseResponse(opts: {
  conversationId?: string;
  userMessageId?: string;
  reply?: string;
}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      if (opts.reply) {
        c.enqueue(
          enc.encode(
            `event: content_delta\ndata: ${JSON.stringify({ text: opts.reply })}\n\n`,
          ),
        );
      }
      c.enqueue(
        enc.encode(
          `event: done\ndata: {"iterations":1,"stop_reason":"model_done"}\n\n`,
        ),
      );
      c.close();
    },
  });
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream",
  };
  if (opts.conversationId) headers["X-Conversation-Id"] = opts.conversationId;
  if (opts.userMessageId) headers["X-User-Message-Id"] = opts.userMessageId;
  return new Response(stream, { status: 200, headers });
}

beforeEach(() => {
  mockSendChat.mockReset();
  mockTruncateConversation.mockReset();
  mockTruncateConversation.mockResolvedValue({ deleted: 2 });
  mockSetMessageFeedback.mockReset();
  mockSetMessageFeedback.mockResolvedValue(undefined);
});

describe("useChat — edit & resend (WARP-844)", () => {
  it("re-ids the optimistic user bubble with the server row id", async () => {
    mockSendChat.mockResolvedValueOnce(
      sseResponse({
        conversationId: "conv-1",
        userMessageId: "um-server-1",
        reply: "hi!",
      }),
    );
    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    await act(async () => {
      await probe!.sendMessage("hello", "m1");
    });

    const user = probe!.messages.find((m) => m.role === "user");
    expect(user?.id).toBe("um-server-1");
  });

  it("editMessage truncates server-side, slices the thread, and re-sends", async () => {
    mockSendChat
      .mockResolvedValueOnce(
        sseResponse({
          conversationId: "conv-1",
          userMessageId: "um-1",
          reply: "first answer",
        }),
      )
      .mockResolvedValueOnce(
        sseResponse({
          conversationId: "conv-1",
          userMessageId: "um-2",
          reply: "edited answer",
        }),
      );
    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    await act(async () => {
      await probe!.sendMessage("original prompt", "m1");
    });
    await waitFor(() => expect(probe!.messages).toHaveLength(2));

    await act(async () => {
      await probe!.editMessage("um-1", "edited prompt", "m1");
    });

    // Truncated from the edited row before the resend.
    expect(mockTruncateConversation).toHaveBeenCalledWith("conv-1", "um-1");
    // Thread now holds exactly the edited turn.
    const contents = probe!.messages.map((m) => [m.role, m.content]);
    expect(contents).toEqual([
      ["user", "edited prompt"],
      ["assistant", "edited answer"],
    ]);
    // The resend replays only history BEFORE the edited message.
    const replayed = (
      mockSendChat.mock.calls[1]![0] as {
        messages: { role: string; content: string }[];
      }
    ).messages;
    expect(replayed).toEqual([{ role: "user", content: "edited prompt" }]);
  });

  it("still edits locally when the truncation call fails", async () => {
    mockTruncateConversation.mockRejectedValueOnce(new Error("404"));
    mockSendChat
      .mockResolvedValueOnce(
        sseResponse({
          conversationId: "conv-1",
          userMessageId: "um-1",
          reply: "a",
        }),
      )
      .mockResolvedValueOnce(sseResponse({ reply: "b" }));
    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    await act(async () => {
      await probe!.sendMessage("original", "m1");
    });
    await act(async () => {
      await probe!.editMessage("um-1", "edited", "m1");
    });

    expect(probe!.messages.map((m) => m.content)).toEqual(["edited", "b"]);
  });

  it("bails out of the resend when the conversation changed during the truncate await (review fix)", async () => {
    mockSendChat.mockResolvedValueOnce(
      sseResponse({
        conversationId: "conv-1",
        userMessageId: "um-1",
        reply: "first answer",
      }),
    );
    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);
    await act(async () => {
      await probe!.sendMessage("original", "m1");
    });

    // While the truncate round-trip is in flight, the user hits
    // "+ New chat" — the edited prompt must NOT be sent into the fresh
    // (or any other) conversation.
    mockTruncateConversation.mockImplementationOnce(async () => {
      probe!.clearMessages();
      return { deleted: 2 };
    });
    await act(async () => {
      await probe!.editMessage("um-1", "edited", "m1");
    });

    expect(mockTruncateConversation).toHaveBeenCalledWith("conv-1", "um-1");
    // Only the original send happened — no resend into the wrong thread.
    expect(mockSendChat).toHaveBeenCalledTimes(1);
  });

  it("rateMessage re-ids the assistant row and persists the rating (WARP-844)", async () => {
    mockSendChat.mockResolvedValueOnce(
      (() => {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(
              enc.encode(`event: content_delta\ndata: {"text":"hi"}\n\n`),
            );
            c.enqueue(
              enc.encode(
                `event: done\ndata: {"iterations":1,"stop_reason":"model_done"}\n\n`,
              ),
            );
            c.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "X-Conversation-Id": "conv-1",
            "X-User-Message-Id": "um-1",
            "X-Assistant-Message-Id": "am-1",
          },
        });
      })(),
    );
    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    await act(async () => {
      await probe!.sendMessage("hello", "m1");
    });

    // The assistant bubble now carries its persisted row id.
    const assistant = probe!.messages.find((m) => m.role === "assistant")!;
    expect(assistant.id).toBe("am-1");

    await act(async () => {
      await probe!.rateMessage("am-1", "up");
    });
    expect(mockSetMessageFeedback).toHaveBeenCalledWith("conv-1", "am-1", "up");
    expect(
      probe!.messages.find((m) => m.id === "am-1")?.feedback,
    ).toBe("up");
  });

  it("rateMessage reverts the optimistic flip when the server rejects", async () => {
    mockSetMessageFeedback.mockRejectedValueOnce(new Error("500"));
    mockSendChat.mockResolvedValueOnce(
      sseResponse({
        conversationId: "conv-1",
        userMessageId: "um-1",
        reply: "x",
      }),
    );
    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);
    await act(async () => {
      await probe!.sendMessage("hello", "m1");
    });
    const assistant = probe!.messages.find((m) => m.role === "assistant")!;

    await act(async () => {
      await probe!.rateMessage(assistant.id, "down");
    });
    expect(
      probe!.messages.find((m) => m.id === assistant.id)?.feedback,
    ).toBeNull();
  });

  it("ignores edits targeting non-user messages", async () => {
    mockSendChat.mockResolvedValueOnce(
      sseResponse({
        conversationId: "conv-1",
        userMessageId: "um-1",
        reply: "answer",
      }),
    );
    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    await act(async () => {
      await probe!.sendMessage("hello", "m1");
    });
    const assistant = probe!.messages.find((m) => m.role === "assistant")!;

    await act(async () => {
      await probe!.editMessage(assistant.id, "nope", "m1");
    });
    expect(mockTruncateConversation).not.toHaveBeenCalled();
    expect(mockSendChat).toHaveBeenCalledTimes(1);
  });
});
