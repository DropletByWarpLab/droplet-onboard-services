import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";

const mockSendChat = vi.fn();
vi.mock("@/lib/api", () => ({
  sendChat: (...args: unknown[]) => mockSendChat(...args),
}));

import { useChat } from "@/lib/hooks/useChat";

interface ProbeValue {
  messages: ReturnType<typeof useChat>["messages"];
  sendMessage: ReturnType<typeof useChat>["sendMessage"];
  regenerate: ReturnType<typeof useChat>["regenerate"];
}

function Probe({ onValue }: { onValue: (v: ProbeValue) => void }) {
  const hook = useChat();
  onValue({
    messages: hook.messages,
    sendMessage: hook.sendMessage,
    regenerate: hook.regenerate,
  });
  return null;
}

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

describe("useChat.regenerate() — WARP-295", () => {
  let value: ProbeValue | null = null;

  beforeEach(() => {
    value = null;
    mockSendChat.mockReset();
  });

  it("drops the targeted assistant turn + the user prompt before it, then re-sends the prompt", async () => {
    mockSendChat
      // Turn 1 — original response.
      .mockResolvedValueOnce(
        sseResponse([
          `event: content_delta\ndata: ${JSON.stringify({ text: "original" })}\n\n`,
          `event: done\ndata: ${JSON.stringify({ iterations: 1, stop_reason: "model_done" })}\n\n`,
        ]),
      )
      // Turn 2 — regenerated response.
      .mockResolvedValueOnce(
        sseResponse([
          `event: content_delta\ndata: ${JSON.stringify({ text: "regenerated" })}\n\n`,
          `event: done\ndata: ${JSON.stringify({ iterations: 1, stop_reason: "model_done" })}\n\n`,
        ]),
      );

    render(<Probe onValue={(v) => (value = v)} />);

    await act(async () => {
      await value!.sendMessage("what is 2+2", "llama3:8b");
    });

    // Capture the assistant message id from turn 1.
    const assistantId = value!.messages.at(-1)!.id;
    expect(value!.messages.at(-1)!.content).toBe("original");

    await act(async () => {
      await value!.regenerate(assistantId, "llama3:8b");
    });

    // The thread should end with the regenerated assistant turn.
    await waitFor(() => {
      const last = value!.messages.at(-1);
      expect(last?.role).toBe("assistant");
      expect(last?.content).toBe("regenerated");
    });

    // The replayed messages on the second call must NOT include the
    // dropped assistant turn — just the user prompt.
    expect(mockSendChat).toHaveBeenCalledTimes(2);
    const secondCall = mockSendChat.mock.calls[1][0] as {
      messages: { role: string; content: string }[];
    };
    expect(secondCall.messages).toEqual([
      { role: "user", content: "what is 2+2" },
    ]);
  });

  it("is a no-op when handed a non-assistant id", async () => {
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

    const userId = value!.messages.find((m) => m.role === "user")!.id;
    await act(async () => {
      await value!.regenerate(userId, "llama3:8b");
    });
    // Only the original turn was sent — regenerate of a user message
    // is a no-op so we don't get a runaway loop.
    expect(mockSendChat).toHaveBeenCalledTimes(1);
  });
});
