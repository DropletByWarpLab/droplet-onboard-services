/**
 * WARP-640 / review #497 — regression test for the reload path of an in-chat
 * `run_scene` confirmation.
 *
 * Romain's finding: reloading a conversation while a `run_scene` chip is still
 * in `confirmation_required` rendered the amber approval block but NO
 * "Approve & run" button, because `loadConversation` dropped the `confirmation`
 * handle when rebuilding tool calls from server state — so
 * `confirmation?.kind === "scene_run"` was never true. The single-use token was
 * still valid server-side but unreachable from the client.
 *
 * These tests drive `loadConversation` (which fetches `GET /conversations/:id`)
 * and assert the rebuilt chip carries the `confirmation` handle, so the button
 * renders again. Mirrors the approveScene-test harness (Probe + StubWebSocket +
 * mocked `@/lib/api`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import type { ChatMessage } from "@/lib/types";
import type { PersistedConversation } from "@/lib/api";

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
  loadConversation: ReturnType<typeof useChat>["loadConversation"];
}

function Probe({ onValue }: { onValue: (v: ProbeValue) => void }) {
  const hook = useChat({});
  onValue({ messages: hook.messages, loadConversation: hook.loadConversation });
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

/**
 * A persisted conversation as the orchestrator now returns it: an assistant
 * message whose `run_scene` tool call is still `confirmation_required` and
 * carries the re-issue handle.
 */
function conversationWithPendingScene(
  withConfirmation: boolean,
): PersistedConversation {
  return {
    id: "conv-1",
    title: "Movie night",
    model: "x",
    provider: "local",
    createdAt: "2026-06-04T00:00:00Z",
    updatedAt: "2026-06-04T00:00:00Z",
    messages: [
      {
        id: "user-1",
        role: "user",
        content: "run movie night",
        toolCalls: null,
        toolCallId: null,
        turnId: null,
        status: "completed",
        createdAt: "2026-06-04T00:00:00Z",
      },
      {
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
            ...(withConfirmation
              ? {
                  confirmation: {
                    kind: "scene_run",
                    sceneId: SCENE_ID,
                    confirmationToken: "tok-abc123",
                  },
                }
              : {}),
          },
        ],
        toolCallId: null,
        turnId: null,
        status: "completed",
        createdAt: "2026-06-04T00:00:00Z",
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

describe("useChat.loadConversation — confirmation handle survives reload (review #497)", () => {
  it("restores the run_scene confirmation handle so 'Approve & run' renders after a reload", async () => {
    mockFetchConversation.mockResolvedValueOnce(conversationWithPendingScene(true));

    let value: ProbeValue | null = null;
    render(<Probe onValue={(v) => (value = v)} />);

    await act(async () => {
      await value!.loadConversation("conv-1");
    });

    await waitFor(() => {
      const asst = value!.messages.find((m) => m.id === "asst-9");
      const call = asst?.toolCalls?.[0];
      expect(call?.status).toBe("confirmation_required");
      // The exact guard the approval button keys off of — was `undefined`
      // before the fix, hiding the button on every reload.
      expect(call?.confirmation?.kind).toBe("scene_run");
      expect(call?.confirmation?.sceneId).toBe(SCENE_ID);
      expect(call?.confirmation?.confirmationToken).toBe("tok-abc123");
    });
  });

  it("leaves a confirmation chip with no re-issue handle untouched on reload (no fabricated token)", async () => {
    mockFetchConversation.mockResolvedValueOnce(conversationWithPendingScene(false));

    let value: ProbeValue | null = null;
    render(<Probe onValue={(v) => (value = v)} />);

    await act(async () => {
      await value!.loadConversation("conv-1");
    });

    await waitFor(() => {
      const asst = value!.messages.find((m) => m.id === "asst-9");
      const call = asst?.toolCalls?.[0];
      expect(call?.status).toBe("confirmation_required");
      // A display-only confirmation (e.g. firewall) must NOT gain a handle.
      expect(call?.confirmation).toBeUndefined();
    });
  });
});
