/**
 * DASH-02 — hero `pendingPrompt` hand-off must only auto-send into a fresh
 * chat, never into a deep-linked / already-populated conversation.
 *
 * The home hero stores `sessionStorage["droplet.pendingPrompt"]` then routes
 * to `/chat`. The chat page consumes it once a model is ready. If the user
 * instead opens a saved thread (`/chat?c=<id>`) while a stale pending prompt
 * is still in sessionStorage, the prompt must be discarded — not appended to
 * that existing conversation. These tests pin both halves of that gate.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";

// ── useChat mock ─────────────────────────────────────────────────────────
// Returned shape is overridable per-test via `chatRef` so we can simulate a
// fresh chat (no conversationId, empty messages) vs a deep-linked thread
// (conversationId set, messages hydrated).
const sendMessageMock = vi.fn();
const loadConversationMock = vi.fn().mockResolvedValue(true);
type ChatMsg = { id: string; role: "user" | "assistant"; content: string };
const chatRef: {
  current: { conversationId: string | null; messages: ChatMsg[] };
} = { current: { conversationId: null, messages: [] } };

vi.mock("@/lib/hooks/useChat", () => ({
  useChat: () => ({
    messages: chatRef.current.messages,
    isStreaming: false,
    sendMessage: sendMessageMock,
    stop: vi.fn(),
    retryMessage: vi.fn(),
    regenerate: vi.fn(),
    clearMessages: vi.fn(),
    attachments: [],
    attach: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    conversationId: chatRef.current.conversationId,
    loadConversation: loadConversationMock,
    messagesEpoch: 0,
  }),
}));

// A model is available immediately so the pending-prompt effect can fire.
vi.mock("@/lib/hooks/useModels", () => ({
  useModels: () => ({ models: [{ id: "m1", provider: "ollama" }] }),
}));

vi.mock("@/lib/hooks/useStickyScroll", () => ({
  STICKY_PX: 80,
  useStickyScroll: () => ({
    scrollRef: { current: null },
    isDetached: false,
    scrollToBottom: vi.fn(),
    onScroll: vi.fn(),
    stickyScrollToBottom: vi.fn(),
  }),
}));

// next/navigation — drive useSearchParams to simulate ?c=<id> deep links.
const searchParamsRef: { current: URLSearchParams } = {
  current: new URLSearchParams(),
};
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => searchParamsRef.current,
  usePathname: () => "/chat",
}));

// SessionHeader does an authFetch; stub it so we don't fight network.
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  // DASH-04: the chat page gates its WS bridge on useAuth().user — the
  // mock must export it (same shape as chat-page.jump-pill.test.tsx).
  useAuth: () => ({
    user: { id: "u1", username: "alice", displayName: "Alice" },
  }),
}));

import ChatPage from "@/app/chat/page";

beforeEach(() => {
  cleanup();
  sendMessageMock.mockReset();
  loadConversationMock.mockReset().mockResolvedValue(true);
  searchParamsRef.current = new URLSearchParams();
  chatRef.current = { conversationId: null, messages: [] };
  window.sessionStorage.clear();
});

describe("DASH-02 hero pendingPrompt gating", () => {
  it("auto-sends the pending prompt for a fresh chat (no ?c=, no messages)", async () => {
    window.sessionStorage.setItem("droplet.pendingPrompt", "summarize my notes");

    render(<ChatPage />);

    await waitFor(() =>
      expect(sendMessageMock).toHaveBeenCalledWith(
        "summarize my notes",
        "m1",
        undefined,
        // WARP-904 — the page now forwards the selected model's provider
        // (looked up from the mocked useModels() list above) on every send.
        "ollama",
      ),
    );
    // Consumed one-shot: removed from storage.
    expect(window.sessionStorage.getItem("droplet.pendingPrompt")).toBeNull();
  });

  it("does NOT send a stale pending prompt into a deep-linked ?c= conversation", async () => {
    // Deep-linked thread already open and hydrated.
    searchParamsRef.current = new URLSearchParams("c=existing-1");
    chatRef.current = {
      conversationId: "existing-1",
      messages: [{ id: "u1", role: "user", content: "prior turn" }],
    };
    window.sessionStorage.setItem("droplet.pendingPrompt", "leftover hero prompt");

    render(<ChatPage />);

    // Give the effect a chance to run, then assert it did NOT auto-send.
    await waitFor(() =>
      // storage is cleared regardless (one-shot consume), so we can wait on that
      expect(window.sessionStorage.getItem("droplet.pendingPrompt")).toBeNull(),
    );
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("does NOT send into an already-populated chat even without a ?c= deep link", async () => {
    // No URL deep link, but the conversation already has messages (e.g. an
    // in-progress thread). A stale hero prompt must not be appended.
    chatRef.current = {
      conversationId: null,
      messages: [{ id: "a1", role: "assistant", content: "existing answer" }],
    };
    window.sessionStorage.setItem("droplet.pendingPrompt", "leftover hero prompt");

    render(<ChatPage />);

    await waitFor(() =>
      expect(window.sessionStorage.getItem("droplet.pendingPrompt")).toBeNull(),
    );
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
