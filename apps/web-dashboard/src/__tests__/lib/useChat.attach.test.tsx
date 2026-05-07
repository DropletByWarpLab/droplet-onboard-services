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
vi.mock("@/lib/api", () => ({
  sendChat: (...args: unknown[]) => mockSendChat(...args),
  uploadBrainFile: (...args: unknown[]) => mockUploadBrainFile(...args),
}));

import { useChat } from "@/lib/hooks/useChat";

interface ProbeValue {
  attachments: ReturnType<typeof useChat>["attachments"];
  attach: ReturnType<typeof useChat>["attach"];
  removeAttachment: ReturnType<typeof useChat>["removeAttachment"];
  clearAttachments: ReturnType<typeof useChat>["clearAttachments"];
}

function Probe({
  onValue,
  chatId,
}: {
  onValue: (v: ProbeValue) => void;
  chatId?: string;
}) {
  const hook = useChat({ chatId });
  onValue({
    attachments: hook.attachments,
    attach: hook.attach,
    removeAttachment: hook.removeAttachment,
    clearAttachments: hook.clearAttachments,
  });
  return null;
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
