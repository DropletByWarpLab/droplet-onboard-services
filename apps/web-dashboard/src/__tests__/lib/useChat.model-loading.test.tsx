/**
 * WARP-903 front-end wiring — the chat surface renders an explicit
 * loading state while the orchestrator cold-loads the selected model,
 * instead of a silent 30-60 s gap:
 *   - a `model_loading` SSE event stamps `modelLoading` onto the
 *     streaming assistant placeholder
 *   - the NEXT event on the stream (first token, reasoning step, tool
 *     call, done) clears it — once the model produces anything it is
 *     resident and the loading copy would be a lie
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
}

function Probe({ onValue }: { onValue: (v: ProbeValue) => void }) {
  const hook = useChat();
  onValue({ messages: hook.messages, sendMessage: hook.sendMessage });
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

/**
 * A stream that delivers `first` immediately, then holds the remaining
 * frames until `release()` — so the test can assert the mid-stream
 * loading state before the first token arrives.
 */
function gatedSseResponse(
  first: string,
  rest: string[],
): { response: Response; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(enc.encode(first));
      await gate;
      for (const f of rest) c.enqueue(enc.encode(f));
      c.close();
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    release,
  };
}

/** Flush a few macrotask turns so in-flight stream reads apply. */
async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

beforeEach(() => {
  mockSendChat.mockReset();
  mockFetchConversation.mockReset();
  mockGetBrainMemoryItems.mockReset();
  mockGetBrainMemoryItems.mockResolvedValue({ items: [] });
});

describe("useChat — model_loading SSE (WARP-903)", () => {
  it("stamps modelLoading onto the streaming placeholder, then clears it on the first token", async () => {
    const { response, release } = gatedSseResponse(
      `event: model_loading\ndata: {"model":"gpt-oss:20b","sizeGb":13.8}\n\n`,
      [
        `event: content_delta\ndata: {"text":"Hi."}\n\n`,
        `event: done\ndata: {"iterations":1,"stop_reason":"model_done"}\n\n`,
      ],
    );
    mockSendChat.mockResolvedValueOnce(response);

    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    let sendPromise!: Promise<void>;
    await act(async () => {
      sendPromise = probe!.sendMessage("hello", "gpt-oss:20b");
      // Let the fetch resolve and the first (loading) frame apply while
      // the rest of the stream is still gated.
      await ticks(5);
    });

    // Cold-load window: the placeholder carries the loading payload and
    // still has no content.
    const streaming = probe!.messages.at(-1)!;
    expect(streaming.role).toBe("assistant");
    expect(streaming.content).toBe("");
    expect(streaming.modelLoading).toEqual({
      model: "gpt-oss:20b",
      sizeGb: 13.8,
    });

    await act(async () => {
      release();
      await sendPromise;
    });

    // First token ended the window; the reply rendered normally.
    const done = probe!.messages.at(-1)!;
    expect(done.content).toBe("Hi.");
    expect(done.modelLoading).toBeUndefined();
  });

  it("clears modelLoading on ANY subsequent event, not just content (reasoning step here)", async () => {
    mockSendChat.mockResolvedValueOnce(
      sseResponse([
        `event: model_loading\ndata: {"model":"qwen3","sizeGb":null}\n\n`,
        `event: reasoning_step\ndata: {"text":"Considering."}\n\n`,
        `event: done\ndata: {"iterations":1,"stop_reason":"model_done"}\n\n`,
      ]),
    );

    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    await act(async () => {
      await probe!.sendMessage("why?", "qwen3");
    });

    const asst = probe!.messages.at(-1)!;
    expect(asst.role).toBe("assistant");
    expect(asst.reasoning).toBe("Considering.");
    expect(asst.modelLoading).toBeUndefined();
  });

  it("leaves turns without the event untouched (warm model wire is unchanged)", async () => {
    mockSendChat.mockResolvedValueOnce(
      sseResponse([
        `event: content_delta\ndata: {"text":"Warm."}\n\n`,
        `event: done\ndata: {"iterations":1,"stop_reason":"model_done"}\n\n`,
      ]),
    );

    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    await act(async () => {
      await probe!.sendMessage("hello", "gpt-oss:20b");
    });

    const asst = probe!.messages.at(-1)!;
    expect(asst.content).toBe("Warm.");
    expect(asst.modelLoading).toBeUndefined();
  });
});
