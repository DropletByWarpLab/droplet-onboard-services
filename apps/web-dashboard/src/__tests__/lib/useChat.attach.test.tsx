/**
 * Unit tests for useChat's WARP-203 attachment surface.
 *
 * Splits cleanly from useChat.test.tsx so we can mock `uploadBrainFile`
 * (the existing tests don't need it) and don't drag the API surface
 * into both files.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";

const mockSendChat = vi.fn();
const mockUploadBrainFile = vi.fn();
const mockFetchConversation = vi.fn();
const mockGetBrainMemoryItems = vi.fn();
vi.mock("@/lib/api", () => ({
  sendChat: (...args: unknown[]) => mockSendChat(...args),
  uploadBrainFile: (...args: unknown[]) => mockUploadBrainFile(...args),
  fetchConversation: (...args: unknown[]) => mockFetchConversation(...args),
  getBrainMemoryItems: (...args: unknown[]) => mockGetBrainMemoryItems(...args),
}));

import { useChat } from "@/lib/hooks/useChat";

interface ProbeValue {
  attachments: ReturnType<typeof useChat>["attachments"];
  attach: ReturnType<typeof useChat>["attach"];
  removeAttachment: ReturnType<typeof useChat>["removeAttachment"];
  clearAttachments: ReturnType<typeof useChat>["clearAttachments"];
  sendMessage: ReturnType<typeof useChat>["sendMessage"];
  loadConversation: ReturnType<typeof useChat>["loadConversation"];
}

function Probe({
  onValue,
  chatId,
  projectId,
}: {
  onValue: (v: ProbeValue) => void;
  chatId?: string;
  projectId?: string | null;
}) {
  const hook = useChat({ chatId, projectId });
  onValue({
    attachments: hook.attachments,
    attach: hook.attach,
    removeAttachment: hook.removeAttachment,
    clearAttachments: hook.clearAttachments,
    sendMessage: hook.sendMessage,
    loadConversation: hook.loadConversation,
  });
  return null;
}

/** Build an SSE response that ends immediately (one `done` frame). */
function quickSseResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
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
    headers: { "Content-Type": "text/event-stream" },
  });
}

// Stub the WebSocket that useChat opens for MQTT status updates so the
// hook doesn't try to dial a real socket in a JSDOM environment. The
// MQTT-driven flip is exercised in a dedicated test below.
class StubWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    StubWebSocket.last = this;
  }
  send() {
    /* no-op */
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  static last: StubWebSocket | null = null;
}

beforeEach(() => {
  mockSendChat.mockReset();
  mockUploadBrainFile.mockReset();
  mockFetchConversation.mockReset();
  mockGetBrainMemoryItems.mockReset();
  mockGetBrainMemoryItems.mockResolvedValue({ items: [] });
  StubWebSocket.last = null;
  // Replace the global WebSocket while the test runs; restore in afterEach.
  vi.stubGlobal("WebSocket", StubWebSocket as unknown);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useChat.attach (WARP-203)", () => {
  it("renders a pending chip immediately and flips to indexing on 202", async () => {
    let resolveUpload: (v: { itemId: string; status: "indexing" }) => void = () => {};
    mockUploadBrainFile.mockImplementationOnce(
      () =>
        new Promise<{ itemId: string; status: "indexing" }>((res) => {
          resolveUpload = res;
        }),
    );

    let value: ProbeValue | null = null;
    render(<Probe onValue={(v) => (value = v)} />);
    expect(value).not.toBeNull();

    const file = new File(["hi"], "notes.md", { type: "text/markdown" });
    let attachPromise!: Promise<string>;
    act(() => {
      attachPromise = value!.attach(file);
    });

    // The pending chip lands synchronously.
    await waitFor(() => {
      expect(value!.attachments.length).toBe(1);
      expect(value!.attachments[0].status).toBe("uploading");
      expect(value!.attachments[0].filename).toBe("notes.md");
      expect(value!.attachments[0].bytes).toBe(2);
      expect(value!.attachments[0].itemId).toBeUndefined();
    });

    // Resolve the upload — chip now carries the itemId and status="indexing".
    await act(async () => {
      resolveUpload({ itemId: "bmi-42", status: "indexing" });
      await attachPromise;
    });
    await waitFor(() => {
      expect(value!.attachments[0].status).toBe("indexing");
      expect(value!.attachments[0].itemId).toBe("bmi-42");
    });
  });

  it("flips chip to failed when the upload route rejects", async () => {
    mockUploadBrainFile.mockRejectedValueOnce(
      new Error("Unsupported file type: video/mp4"),
    );

    let value: ProbeValue | null = null;
    render(<Probe onValue={(v) => (value = v)} />);

    const file = new File(["x"], "movie.mp4", { type: "video/mp4" });
    await act(async () => {
      await value!.attach(file);
    });

    expect(value!.attachments[0].status).toBe("failed");
    expect(value!.attachments[0].error).toBe(
      "Unsupported file type: video/mp4",
    );
  });

  it("forwards chatId to uploadBrainFile when set", async () => {
    mockUploadBrainFile.mockResolvedValueOnce({
      itemId: "bmi-1",
      status: "indexing",
    });
    let value: ProbeValue | null = null;
    render(<Probe onValue={(v) => (value = v)} chatId="chat-99" />);

    const file = new File(["x"], "x.txt", { type: "text/plain" });
    await act(async () => {
      await value!.attach(file);
    });
    expect(mockUploadBrainFile).toHaveBeenCalledWith(file, "chat-99");
  });

  it("removeAttachment drops one chip; clearAttachments drops all", async () => {
    mockUploadBrainFile.mockResolvedValue({
      itemId: "bmi",
      status: "indexing",
    });
    let value: ProbeValue | null = null;
    render(<Probe onValue={(v) => (value = v)} />);

    let id1 = "";
    let id2 = "";
    await act(async () => {
      id1 = await value!.attach(
        new File(["a"], "a.txt", { type: "text/plain" }),
      );
      id2 = await value!.attach(
        new File(["b"], "b.txt", { type: "text/plain" }),
      );
    });
    expect(value!.attachments.length).toBe(2);

    act(() => {
      value!.removeAttachment(id1);
    });
    expect(value!.attachments.length).toBe(1);
    expect(value!.attachments[0].localId).toBe(id2);

    act(() => {
      value!.clearAttachments();
    });
    expect(value!.attachments.length).toBe(0);
  });

  it("flips chip to ready when the WS bridge delivers brain/indexed for its itemId", async () => {
    mockUploadBrainFile.mockResolvedValueOnce({
      itemId: "bmi-77",
      status: "indexing",
    });

    let value: ProbeValue | null = null;
    render(<Probe onValue={(v) => (value = v)} />);

    await act(async () => {
      await value!.attach(
        new File(["a"], "a.txt", { type: "text/plain" }),
      );
    });
    expect(value!.attachments[0].status).toBe("indexing");

    // The hook opens a WebSocket on mount; grab the stub and fire a
    // ready message for our itemId.
    const sock = StubWebSocket.last;
    expect(sock).not.toBeNull();
    await act(async () => {
      sock!.onmessage?.({
        data: JSON.stringify({
          topic: "droplet/files/dev/brain/indexed",
          payload: { itemId: "bmi-77", status: "ready" },
        }),
      });
    });
    await waitFor(() => {
      expect(value!.attachments[0].status).toBe("ready");
    });
  });

  it("sends attachment itemIds with the chat turn so the model sees them", async () => {
    mockUploadBrainFile.mockResolvedValueOnce({
      itemId: "bmi-42",
      status: "indexing",
    });
    mockSendChat.mockResolvedValueOnce(quickSseResponse());

    let value: ProbeValue | null = null;
    render(<Probe onValue={(v) => (value = v)} />);

    await act(async () => {
      await value!.attach(
        new File(["hi"], "notes.md", { type: "text/markdown" }),
      );
    });
    await act(async () => {
      await value!.sendMessage("summarize my notes", "llama3");
    });

    expect(mockSendChat).toHaveBeenCalledOnce();
    const body = mockSendChat.mock.calls[0]![0] as {
      attachments?: { itemId: string }[];
    };
    expect(body.attachments).toEqual([{ itemId: "bmi-42" }]);
  });

  it("omits attachments from the turn when no chip has an itemId yet", async () => {
    // Upload never resolves — the chip stays in "uploading" with no itemId.
    mockUploadBrainFile.mockImplementationOnce(() => new Promise(() => {}));
    mockSendChat.mockResolvedValueOnce(quickSseResponse());

    let value: ProbeValue | null = null;
    render(<Probe onValue={(v) => (value = v)} />);

    act(() => {
      void value!.attach(new File(["x"], "x.txt", { type: "text/plain" }));
    });
    await act(async () => {
      await value!.sendMessage("hello", "llama3");
    });

    const body = mockSendChat.mock.calls[0]![0] as {
      attachments?: { itemId: string }[];
    };
    expect(body.attachments).toBeUndefined();
  });

  it("tags uploads with the server conversationId once one exists", async () => {
    // First turn establishes conv-9 via the response header.
    mockSendChat.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                `event: done\ndata: {"iterations":1,"stop_reason":"model_done"}\n\n`,
              ),
            );
            c.close();
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "X-Conversation-Id": "conv-9",
          },
        },
      ),
    );
    mockUploadBrainFile.mockResolvedValueOnce({
      itemId: "bmi-1",
      status: "indexing",
    });

    let value: ProbeValue | null = null;
    render(<Probe onValue={(v) => (value = v)} chatId="chat-draft" />);

    await act(async () => {
      await value!.sendMessage("hello", "m1");
    });
    await act(async () => {
      await value!.attach(new File(["x"], "x.txt", { type: "text/plain" }));
    });

    // Post-first-turn uploads carry the durable server id, not the
    // client-minted draft chatId.
    expect(mockUploadBrainFile).toHaveBeenCalledWith(expect.anything(), "conv-9");
  });

  it("rehydrates attachment chips from brain items on loadConversation", async () => {
    mockFetchConversation.mockResolvedValueOnce({
      id: "conv-55",
      title: "Docs chat",
      model: "m1",
      provider: "ollama",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        {
          id: "m1",
          role: "user",
          content: "summarize",
          toolCalls: null,
          toolCallId: null,
          turnId: "t1",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    mockGetBrainMemoryItems.mockResolvedValueOnce({
      items: [
        {
          id: "bmi-9",
          filename: "report.pdf",
          mimeType: "application/pdf",
          bytes: 1234,
          status: "ready",
        },
        {
          id: "bmi-10",
          filename: "meeting.mp3",
          mimeType: "audio/mpeg",
          bytes: 999,
          status: "queued_for_transcription",
        },
      ],
    });

    let value: ProbeValue | null = null;
    render(<Probe onValue={(v) => (value = v)} />);

    await act(async () => {
      await value!.loadConversation("conv-55");
    });

    expect(mockGetBrainMemoryItems).toHaveBeenCalledWith({
      originatingChatId: "conv-55",
    });
    await waitFor(() => {
      expect(value!.attachments).toHaveLength(2);
    });
    expect(value!.attachments[0]).toMatchObject({
      itemId: "bmi-9",
      filename: "report.pdf",
      status: "ready",
    });
    // queued_for_transcription renders as the indexing chip state.
    expect(value!.attachments[1]).toMatchObject({
      itemId: "bmi-10",
      status: "indexing",
    });
  });

  it("sends draftChatId on the first turn only (draft-upload adoption)", async () => {
    const quick = (convId: string) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                `event: done\ndata: {"iterations":1,"stop_reason":"model_done"}\n\n`,
              ),
            );
            c.close();
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "X-Conversation-Id": convId,
          },
        },
      );
    mockSendChat
      .mockResolvedValueOnce(quick("conv-5"))
      .mockResolvedValueOnce(quick("conv-5"));

    let value: ProbeValue | null = null;
    render(<Probe onValue={(v) => (value = v)} chatId="chat-draft-77" />);

    await act(async () => {
      await value!.sendMessage("first", "m1");
    });
    expect(mockSendChat.mock.calls[0]![0]).toMatchObject({
      draftChatId: "chat-draft-77",
    });

    await act(async () => {
      await value!.sendMessage("second", "m1");
    });
    const second = mockSendChat.mock.calls[1]![0] as { draftChatId?: string };
    expect(second.draftChatId).toBeUndefined();
  });

  it("sends projectId on the first turn only (WARP-845 project stamping)", async () => {
    const quick = (convId: string) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                `event: done\ndata: {"iterations":1,"stop_reason":"model_done"}\n\n`,
              ),
            );
            c.close();
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "X-Conversation-Id": convId,
          },
        },
      );
    mockSendChat
      .mockResolvedValueOnce(quick("conv-9"))
      .mockResolvedValueOnce(quick("conv-9"));

    let value: ProbeValue | null = null;
    render(<Probe onValue={(v) => (value = v)} projectId="proj-1" />);

    await act(async () => {
      await value!.sendMessage("first", "m1");
    });
    expect(mockSendChat.mock.calls[0]![0]).toMatchObject({
      projectId: "proj-1",
    });

    // Second turn: conversation already exists server-side — membership is
    // already stamped, so projectId must not be re-sent.
    await act(async () => {
      await value!.sendMessage("second", "m1");
    });
    const second2 = mockSendChat.mock.calls[1]![0] as { projectId?: string };
    expect(second2.projectId).toBeUndefined();
  });

  it("refuses the 9th attachment with a visible failed chip (review fix)", async () => {
    mockUploadBrainFile.mockResolvedValue({ itemId: "bmi", status: "indexing" });
    let value: ProbeValue | null = null;
    render(<Probe onValue={(v) => (value = v)} />);

    await act(async () => {
      for (let i = 0; i < 8; i++) {
        await value!.attach(new File(["x"], `f${i}.txt`, { type: "text/plain" }));
      }
    });
    expect(mockUploadBrainFile).toHaveBeenCalledTimes(8);

    await act(async () => {
      await value!.attach(new File(["x"], "ninth.txt", { type: "text/plain" }));
    });
    // No 9th upload; the chip surfaces the limit instead of silently
    // rendering as attached-but-never-sent.
    expect(mockUploadBrainFile).toHaveBeenCalledTimes(8);
    const ninth = value!.attachments.find((a) => a.filename === "ninth.txt")!;
    expect(ninth.status).toBe("failed");
    expect(ninth.error).toMatch(/limit/i);
  });

  it("drops a stale chip rehydration when another conversation loaded meanwhile (review fix)", async () => {
    const conv = (id: string) => ({
      id,
      title: id,
      model: "m1",
      provider: "ollama",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        {
          id: `${id}-m1`,
          role: "user",
          content: "hi",
          toolCalls: null,
          toolCallId: null,
          turnId: "t1",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    mockFetchConversation.mockImplementation(async (id: string) => conv(id));

    // Conversation A's chip fetch hangs until we release it; B's resolves
    // immediately.
    let releaseA: (v: { items: unknown[] }) => void = () => {};
    mockGetBrainMemoryItems.mockImplementation(
      async ({ originatingChatId }: { originatingChatId: string }) => {
        if (originatingChatId === "conv-A") {
          return new Promise((res) => {
            releaseA = res;
          });
        }
        return {
          items: [
            {
              id: "bmi-B",
              filename: "b.pdf",
              mimeType: "application/pdf",
              bytes: 1,
              status: "ready",
              uploadedAt: "2026-06-09T10:00:00.000Z",
            },
          ],
        };
      },
    );

    let value: ProbeValue | null = null;
    render(<Probe onValue={(v) => (value = v)} />);

    let loadA!: Promise<boolean>;
    await act(async () => {
      loadA = value!.loadConversation("conv-A");
      // A's messages resolve; its chip fetch is now pending.
      await Promise.resolve();
    });
    await act(async () => {
      await value!.loadConversation("conv-B");
    });
    await waitFor(() => {
      expect(value!.attachments.map((a) => a.itemId)).toEqual(["bmi-B"]);
    });

    // The slow loser resolves late — it must NOT clobber B's chips.
    await act(async () => {
      releaseA({
        items: [
          {
            id: "bmi-A",
            filename: "a.pdf",
            mimeType: "application/pdf",
            bytes: 1,
            status: "ready",
            uploadedAt: "2026-06-09T09:00:00.000Z",
          },
        ],
      });
      await loadA;
    });
    expect(value!.attachments.map((a) => a.itemId)).toEqual(["bmi-B"]);
  });

  it("ignores WS messages that aren't brain/indexed or for a different itemId", async () => {
    mockUploadBrainFile.mockResolvedValueOnce({
      itemId: "bmi-A",
      status: "indexing",
    });
    let value: ProbeValue | null = null;
    render(<Probe onValue={(v) => (value = v)} />);

    await act(async () => {
      await value!.attach(
        new File(["a"], "a.txt", { type: "text/plain" }),
      );
    });

    const sock = StubWebSocket.last!;
    // Unrelated topic — should not flip the chip.
    await act(async () => {
      sock.onmessage?.({
        data: JSON.stringify({
          topic: "droplet/files/dev/uploaded",
          payload: { itemId: "bmi-A", status: "ready" },
        }),
      });
      // Right topic, wrong itemId — also should not flip.
      sock.onmessage?.({
        data: JSON.stringify({
          topic: "droplet/files/dev/brain/indexed",
          payload: { itemId: "bmi-OTHER", status: "ready" },
        }),
      });
    });
    expect(value!.attachments[0].status).toBe("indexing");
  });
});
