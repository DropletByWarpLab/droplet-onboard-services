/**
 * WARP-3303 — the message a background run posts into the chat that started
 * it (`kind: "agent_run_result"`, WARP-3300).
 *
 * Reload must turn it into a result card (`runResult`), and the next send
 * must still replay its plain-text `content` to the model — that replay is
 * the whole mechanism by which the model "knows" the run's result without a
 * polling tool.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import type { ChatMessage } from "@/lib/types";
import type { PersistedConversation } from "@/lib/api";

const mockSendChat = vi.fn();
const mockFetchConversation = vi.fn();
vi.mock("@/lib/api", () => ({
  sendChat: (...a: unknown[]) => mockSendChat(...a),
  uploadBrainFile: vi.fn(),
  fetchConversation: (...a: unknown[]) => mockFetchConversation(...a),
  getBrainMemoryItems: vi.fn().mockResolvedValue({ items: [] }),
}));

import { useChat } from "@/lib/hooks/useChat";

type Hook = ReturnType<typeof useChat>;
function Probe({ onValue }: { onValue: (v: Hook) => void }) {
  onValue(useChat({}));
  return null;
}

class StubWebSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  send() {}
  close() {
    this.readyState = 3;
  }
}

const RESULT_TEXT = 'Background task "Supplier price check" finished: Brightline is cheapest at $39.';

function conversation(): PersistedConversation {
  const base = { toolCalls: null, toolCallId: null, turnId: null, status: "completed" as const, createdAt: "2026-09-28T00:00:00Z" };
  return {
    id: "conv-1",
    title: "Suppliers",
    model: "x",
    provider: "local",
    createdAt: "2026-09-28T00:00:00Z",
    updatedAt: "2026-09-28T00:00:00Z",
    messages: [
      { ...base, id: "u1", role: "user", content: "compare our three suppliers in the background" },
      { ...base, id: "a1", role: "assistant", content: "Started it." },
      {
        ...base,
        id: "r1",
        role: "assistant",
        content: RESULT_TEXT,
        turnId: "agent-run:run-7",
        kind: "agent_run_result",
        meta: {
          runId: "run-7",
          status: "succeeded",
          title: "Supplier price check",
          summary: "Brightline is cheapest at $39.",
          artifacts: [{ kind: "file", ref: "/Docs/suppliers.md", title: "suppliers.md" }],
        },
      },
    ],
  };
}

beforeEach(() => {
  mockSendChat.mockReset();
  mockFetchConversation.mockReset();
  vi.stubGlobal("WebSocket", StubWebSocket as unknown);
});
afterEach(() => vi.unstubAllGlobals());

describe("useChat — background run result messages (WARP-3303)", () => {
  it("maps an agent_run_result message to a result card on reload", async () => {
    mockFetchConversation.mockResolvedValueOnce(conversation());
    let hook: Hook | null = null;
    render(<Probe onValue={(v) => (hook = v)} />);
    await act(async () => {
      await hook!.loadConversation("conv-1");
    });
    await waitFor(() => {
      const r = hook!.messages.find((m: ChatMessage) => m.id === "r1");
      expect(r?.runResult).toEqual({
        runId: "run-7",
        status: "succeeded",
        title: "Supplier price check",
        summary: "Brightline is cheapest at $39.",
        artifacts: [{ kind: "file", ref: "/Docs/suppliers.md", title: "suppliers.md" }],
      });
      // An ordinary message gets no card.
      expect(hook!.messages.find((m: ChatMessage) => m.id === "a1")?.runResult).toBeUndefined();
    });
  });

  it("replays the result's plain text to the model on the next send", async () => {
    mockFetchConversation.mockResolvedValueOnce(conversation());
    mockSendChat.mockRejectedValueOnce(new Error("stop here"));
    let hook: Hook | null = null;
    render(<Probe onValue={(v) => (hook = v)} />);
    await act(async () => {
      await hook!.loadConversation("conv-1");
    });
    await act(async () => {
      await hook!.sendMessage("which one was cheapest?", "x").catch(() => {});
    });
    expect(mockSendChat).toHaveBeenCalled();
    const sent = mockSendChat.mock.calls[0][0] as { messages: { role: string; content: string }[] };
    expect(sent.messages).toContainEqual({ role: "assistant", content: RESULT_TEXT });
    expect(sent.messages.at(-1)).toEqual({ role: "user", content: "which one was cheapest?" });
  });
});
