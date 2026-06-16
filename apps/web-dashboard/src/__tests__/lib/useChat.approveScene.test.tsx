/**
 * WARP-640 — unit tests for useChat.approveScene, the in-chat scene-run
 * confirmation completer. Split from the other useChat suites so we can mock
 * `runSceneConfirmed` in isolation. Mirrors the attach-test harness: a Probe
 * surfaces the hook's messages + mutators, and a StubWebSocket keeps the hook's
 * MQTT socket from dialing in JSDOM.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import type { ChatMessage } from "@/lib/types";

const mockSendChat = vi.fn();
const mockUploadBrainFile = vi.fn();
const mockFetchConversation = vi.fn();
const mockRunSceneConfirmed = vi.fn();
vi.mock("@/lib/api", () => ({
  sendChat: (...a: unknown[]) => mockSendChat(...a),
  uploadBrainFile: (...a: unknown[]) => mockUploadBrainFile(...a),
  fetchConversation: (...a: unknown[]) => mockFetchConversation(...a),
  runSceneConfirmed: (...a: unknown[]) => mockRunSceneConfirmed(...a),
}));

import { useChat } from "@/lib/hooks/useChat";

interface ProbeValue {
  messages: ChatMessage[];
  setMessages: ReturnType<typeof useChat>["setMessages"];
  approveScene: ReturnType<typeof useChat>["approveScene"];
}

function Probe({ onValue }: { onValue: (v: ProbeValue) => void }) {
  const hook = useChat({});
  onValue({
    messages: hook.messages,
    setMessages: hook.setMessages,
    approveScene: hook.approveScene,
  });
  return null;
}

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

const SCENE_ID = "11111111-2222-3333-4444-555555555555";

function sceneConfirmMessage(): ChatMessage {
  return {
    id: "asst-9",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "call-scene",
        name: "run_scene",
        args: { scene: "Movie night" },
        ok: true,
        status: "confirmation_required",
        message: 'Running "Movie night" will run 2 device action(s).',
        confirmation: {
          kind: "scene_run",
          sceneId: SCENE_ID,
          confirmationToken: "tok-abc123",
        },
      },
    ],
  };
}

beforeEach(() => {
  mockSendChat.mockReset();
  mockUploadBrainFile.mockReset();
  mockFetchConversation.mockReset();
  mockRunSceneConfirmed.mockReset();
  StubWebSocket.last = null;
  vi.stubGlobal("WebSocket", StubWebSocket as unknown);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useChat.approveScene (WARP-640)", () => {
  it("echoes the single-use token to runSceneConfirmed and resolves the chip green on a full run", async () => {
    mockRunSceneConfirmed.mockResolvedValueOnce({
      sceneId: SCENE_ID,
      successCount: 2,
      actionCount: 2,
      results: [],
    });

    let value: ProbeValue | null = null;
    render(<Probe onValue={(v) => (value = v)} />);
    act(() => {
      value!.setMessages([sceneConfirmMessage()]);
    });

    await act(async () => {
      await value!.approveScene("asst-9", "call-scene");
    });

    expect(mockRunSceneConfirmed).toHaveBeenCalledTimes(1);
    expect(mockRunSceneConfirmed).toHaveBeenCalledWith(SCENE_ID, "tok-abc123");

    await waitFor(() => {
      const call = value!.messages[0].toolCalls![0];
      expect(call.confirmState).toBe("ran");
      // confirmation_required cleared → the amber approval block dismisses.
      expect(call.status).toBe("ok");
      expect(call.ok).toBe(true);
      expect(call.message).toMatch(/Ran all 2 action/i);
    });
  });

  it("flips the chip red (status=error, ok=false) on a partial run", async () => {
    mockRunSceneConfirmed.mockResolvedValueOnce({
      sceneId: SCENE_ID,
      successCount: 1,
      actionCount: 2,
      results: [],
    });

    let value: ProbeValue | null = null;
    render(<Probe onValue={(v) => (value = v)} />);
    act(() => {
      value!.setMessages([sceneConfirmMessage()]);
    });

    await act(async () => {
      await value!.approveScene("asst-9", "call-scene");
    });

    await waitFor(() => {
      const call = value!.messages[0].toolCalls![0];
      expect(call.confirmState).toBe("ran");
      expect(call.status).toBe("error");
      expect(call.ok).toBe(false);
      expect(call.message).toMatch(/Ran 1 of 2/i);
    });
  });

  it("marks the chip failed (keeping the approval block) when the run throws — token is single-use", async () => {
    mockRunSceneConfirmed.mockRejectedValueOnce(new Error("confirmation_invalid"));

    let value: ProbeValue | null = null;
    render(<Probe onValue={(v) => (value = v)} />);
    act(() => {
      value!.setMessages([sceneConfirmMessage()]);
    });

    await act(async () => {
      await value!.approveScene("asst-9", "call-scene");
    });

    await waitFor(() => {
      const call = value!.messages[0].toolCalls![0];
      expect(call.confirmState).toBe("failed");
      // status stays confirmation_required so the block stays visible with the
      // failed note — the user re-asks (mints a fresh token) rather than
      // retrying the spent one.
      expect(call.status).toBe("confirmation_required");
      expect(call.message).toBe("confirmation_invalid");
    });
  });

  it("is a no-op for a confirmation with no re-issue handle (firewall tool)", async () => {
    let value: ProbeValue | null = null;
    render(<Probe onValue={(v) => (value = v)} />);
    act(() => {
      value!.setMessages([
        {
          id: "asst-fw",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-fw",
              name: "block_network_device",
              args: { mac: "AA:BB:CC:DD:EE:FF" },
              ok: true,
              status: "confirmation_required",
              message: "Open the dashboard to approve",
              // no `confirmation` handle
            },
          ],
        },
      ]);
    });

    await act(async () => {
      await value!.approveScene("asst-fw", "call-fw");
    });

    expect(mockRunSceneConfirmed).not.toHaveBeenCalled();
    expect(value!.messages[0].toolCalls![0].confirmState).toBeUndefined();
  });

  it("guards against double-submit while a run is in flight", async () => {
    let resolveRun: (v: unknown) => void = () => {};
    mockRunSceneConfirmed.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveRun = res;
        }),
    );

    let value: ProbeValue | null = null;
    render(<Probe onValue={(v) => (value = v)} />);
    act(() => {
      value!.setMessages([sceneConfirmMessage()]);
    });

    // First click — leaves the chip in "running" (runSceneConfirmed pending).
    let firstCall!: Promise<void>;
    await act(async () => {
      firstCall = value!.approveScene("asst-9", "call-scene");
    });
    await waitFor(() => {
      expect(value!.messages[0].toolCalls![0].confirmState).toBe("running");
    });

    // Second click while still running must be ignored.
    await act(async () => {
      await value!.approveScene("asst-9", "call-scene");
    });
    expect(mockRunSceneConfirmed).toHaveBeenCalledTimes(1);

    // Let the in-flight run finish.
    await act(async () => {
      resolveRun({ sceneId: SCENE_ID, successCount: 2, actionCount: 2, results: [] });
      await firstCall;
    });
    await waitFor(() => {
      expect(value!.messages[0].toolCalls![0].confirmState).toBe("ran");
    });
  });
});
