import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";

// Hoisted mock — `sendChat` is the canonical entry point for the
// MCP-backed agent loop. The stop()-path test asserts the hook threads
// an AbortSignal through and that aborting flips state cleanly.
const mockSendChat = vi.fn();
vi.mock("@/lib/api", () => ({
  sendChat: (...args: unknown[]) => mockSendChat(...args),
}));

import { useChat } from "@/lib/hooks/useChat";

interface ProbeValue {
  messages: ReturnType<typeof useChat>["messages"];
  isStreaming: boolean;
  sendMessage: ReturnType<typeof useChat>["sendMessage"];
  stop: ReturnType<typeof useChat>["stop"];
}

function Probe({ onValue }: { onValue: (v: ProbeValue) => void }) {
  const hook = useChat();
  onValue({
    messages: hook.messages,
    isStreaming: hook.isStreaming,
    sendMessage: hook.sendMessage,
    stop: hook.stop,
  });
  return null;
}

/**
 * Build a controllable SSE response. The returned `push(frame)` writes a
 * frame into the stream; `close()` ends it; `abortPromise` resolves when
 * the AbortSignal handed to sendChat fires (we use it to release the
 * reader so the hook's finally-block can run).
 */
function controllableSseResponse(signal?: AbortSignal): {
  response: Response;
  push: (frame: string) => void;
  close: () => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      // When the consumer aborts, error out the stream so the reader's
      // `read()` rejects and the hook's catch+finally runs. Mirrors how
      // fetch's underlying stream behaves under signal-abort.
      signal?.addEventListener("abort", () => {
        try {
          controller.error(new DOMException("Aborted", "AbortError"));
        } catch {
          /* already closed */
        }
      });
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    push: (frame: string) => {
      try {
        controller.enqueue(enc.encode(frame));
      } catch {
        /* already closed */
      }
    },
    close: () => {
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
  };
}

describe("useChat.stop() — WARP-295", () => {
  let value: ProbeValue | null = null;

  beforeEach(() => {
    value = null;
    mockSendChat.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("threads an AbortSignal through sendChat so the orchestrator stream can be cancelled", async () => {
    let capturedSignal: AbortSignal | undefined;
    mockSendChat.mockImplementationOnce((req: { signal?: AbortSignal }) => {
      capturedSignal = req.signal;
      const stream = controllableSseResponse(req.signal);
      // Push one frame then leave the stream open — caller drives the
      // lifecycle via stop().
      stream.push(
        `event: content_delta\ndata: ${JSON.stringify({ text: "Hel" })}\n\n`,
      );
      return Promise.resolve(stream.response);
    });

    render(<Probe onValue={(v) => (value = v)} />);

    // Kick off the turn but do NOT await — the stream is intentionally
    // open so we can verify the in-flight signal is wired up.
    let sendPromise: Promise<void> | null = null;
    act(() => {
      sendPromise = value!.sendMessage("hi", "llama3:8b");
    });

    await waitFor(() => {
      expect(capturedSignal).toBeDefined();
    });
    expect(capturedSignal!.aborted).toBe(false);
    expect(value!.isStreaming).toBe(true);

    // Aborting the stream releases the reader; let the turn settle.
    await act(async () => {
      value!.stop();
      await sendPromise;
    });

    expect(capturedSignal!.aborted).toBe(true);
  });

  it("stop() flips isStreaming back to false and preserves the partial assistant message with a stopped marker", async () => {
    mockSendChat.mockImplementationOnce((req: { signal?: AbortSignal }) => {
      const stream = controllableSseResponse(req.signal);
      stream.push(
        `event: content_delta\ndata: ${JSON.stringify({ text: "Partial " })}\n\n`,
      );
      stream.push(
        `event: content_delta\ndata: ${JSON.stringify({ text: "answer" })}\n\n`,
      );
      // Stream stays open — the user will stop() mid-flight.
      return Promise.resolve(stream.response);
    });

    render(<Probe onValue={(v) => (value = v)} />);

    let sendPromise: Promise<void> | null = null;
    act(() => {
      sendPromise = value!.sendMessage("what's up", "llama3:8b");
    });

    // Wait for the partial content to land before stopping.
    await waitFor(() => {
      const last = value!.messages.at(-1);
      expect(last?.content).toBe("Partial answer");
    });

    await act(async () => {
      value!.stop();
      await sendPromise;
    });

    // After stop: the partial content survives (no "I can't reach the
    // Droplet" wipe), isStreaming flips false, and a `stopped` marker
    // tells the ChatMessage layer to render the "Stopped by you" tag.
    expect(value!.isStreaming).toBe(false);
    const last = value!.messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.content).toBe("Partial answer");
    expect(last.stopped).toBe(true);
    // Stopping is NOT an error — the friendly-error path is reserved
    // for fetch/network failures.
    expect(last.error).toBeUndefined();
  });

  it("stop() is a no-op when no stream is in flight", async () => {
    render(<Probe onValue={(v) => (value = v)} />);
    expect(value!.isStreaming).toBe(false);
    // Must not throw — the page wires this to a button that may be
    // clicked after the stream ends if state hasn't propagated yet.
    expect(() => value!.stop()).not.toThrow();
    expect(value!.isStreaming).toBe(false);
  });
});
