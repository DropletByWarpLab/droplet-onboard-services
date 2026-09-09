/**
 * WARP-829 — the `/tools` "Use in chat" hand-off SEEDS the chat composer but
 * never sends. The tools page writes a `droplet.pendingComposer` payload to
 * sessionStorage and routes to `/chat`; on a FRESH chat the chat page reads it
 * once, seeds the composer with the starter line, pins a "acting on <tool>"
 * indicator with the correct safety chip (Writes / Asks first), and clears the
 * payload. It must NOT auto-send — unlike `droplet.pendingPrompt` (the hero
 * hand-off, covered in chat-page.pending-prompt.test.tsx).
 *
 * These tests pin: the seed lands in the composer, the indicator + safety chip
 * render, sendMessage is NOT called, the payload is consumed one-shot, and a
 * deep-linked / already-populated chat ignores the payload entirely.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
// WARP-2582 — PendingComposerPayload became a union (tool | pin). This suite
// exercises the TOOL variant, so it names that directly: typing the literal as
// the union lets the `...p` spread widen `kind` to "tool" | "pin".
import { PENDING_COMPOSER_KEY, type PendingComposerToolPayload } from "@/lib/types";

// ── useChat mock — overridable per-test via chatRef (fresh vs deep-linked). ──
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
    approveScene: vi.fn(),
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

// A model is available immediately so the on-arrival effect can fire.
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

const searchParamsRef: { current: URLSearchParams } = {
  current: new URLSearchParams(),
};
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => searchParamsRef.current,
  usePathname: () => "/chat",
}));

// AuthGate normally provides the user; the chat page reads useAuth().user.
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", role: "owner" } }),
  authFetch: vi.fn(),
}));

import ChatPage from "@/app/chat/page";

function writePayload(p: Partial<PendingComposerToolPayload> = {}) {
  const payload: PendingComposerToolPayload = {
    kind: "tool",
    toolName: "block_network_device",
    label: "Block network device",
    requiresWrite: true,
    requiresConfirmation: true,
    seedText: "Using network, ",
    ...p,
  };
  window.sessionStorage.setItem(PENDING_COMPOSER_KEY, JSON.stringify(payload));
}

beforeEach(() => {
  cleanup();
  sendMessageMock.mockReset();
  loadConversationMock.mockReset().mockResolvedValue(true);
  searchParamsRef.current = new URLSearchParams();
  chatRef.current = { conversationId: null, messages: [] };
  window.sessionStorage.clear();
});

describe("WARP-829 chat-page pendingComposer (seed-not-send)", () => {
  it("seeds the composer with the starter line on a fresh chat", async () => {
    writePayload({ seedText: "Using network, " });

    render(<ChatPage />);

    const textarea = (await screen.findByPlaceholderText(
      "Ask Droplet anything…",
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe("Using network, "));
  });

  it("pins an 'acting on <tool>' indicator naming the tool", async () => {
    writePayload({ label: "Block network device" });

    render(<ChatPage />);

    // The indicator names the tool in plain language.
    const indicator = await screen.findByText(/block network device/i);
    expect(indicator).toBeInTheDocument();
  });

  it("renders the Writes safety chip when requiresWrite is true", async () => {
    writePayload({ requiresWrite: true, requiresConfirmation: false });

    render(<ChatPage />);

    await waitFor(() =>
      expect(screen.getByText(/writes/i)).toBeInTheDocument(),
    );
    // Not a confirmation-only tool → no "Asks first" chip.
    expect(screen.queryByText(/asks first/i)).not.toBeInTheDocument();
  });

  it("renders the Asks-first safety chip when requiresConfirmation is true", async () => {
    writePayload({ requiresWrite: false, requiresConfirmation: true });

    render(<ChatPage />);

    await waitFor(() =>
      expect(screen.getByText(/asks first/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/writes/i)).not.toBeInTheDocument();
  });

  it("does NOT auto-send the seeded tool", async () => {
    writePayload();

    render(<ChatPage />);

    // Wait for the one-shot consume, then assert nothing was sent.
    await waitFor(() =>
      expect(window.sessionStorage.getItem(PENDING_COMPOSER_KEY)).toBeNull(),
    );
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("consumes the payload one-shot (clears it from sessionStorage)", async () => {
    writePayload();

    render(<ChatPage />);

    await waitFor(() =>
      expect(window.sessionStorage.getItem(PENDING_COMPOSER_KEY)).toBeNull(),
    );
  });

  it("does NOT consume the payload on a deep-linked ?c= thread", async () => {
    searchParamsRef.current = new URLSearchParams("c=existing-1");
    chatRef.current = {
      conversationId: "existing-1",
      messages: [{ id: "u1", role: "user", content: "prior turn" }],
    };
    writePayload({ label: "Block network device" });

    render(<ChatPage />);

    // Let the mount effects settle (await a stable element rather than the
    // loadConversation side effect, which is exercised elsewhere). A
    // deep-linked thread must NOT be hijacked: the payload stays put, no
    // "acting on" indicator renders, and nothing is sent.
    await screen.findByPlaceholderText("Ask Droplet anything…");
    expect(window.sessionStorage.getItem(PENDING_COMPOSER_KEY)).not.toBeNull();
    // The indicator (which would name the tool) must not render for a
    // deep-linked thread.
    expect(screen.queryByText(/block network device/i)).not.toBeInTheDocument();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("does NOT consume the payload when the chat already has messages", async () => {
    chatRef.current = {
      conversationId: null,
      messages: [{ id: "a1", role: "assistant", content: "existing answer" }],
    };
    writePayload();

    render(<ChatPage />);

    // No deep link, but the conversation isn't empty → leave the payload alone.
    await waitFor(() => {
      expect(screen.getByPlaceholderText("Ask Droplet anything…")).toBeInTheDocument();
    });
    expect(window.sessionStorage.getItem(PENDING_COMPOSER_KEY)).not.toBeNull();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("still auto-sends a droplet.pendingPrompt hero hand-off (regression)", async () => {
    // The seed path must not break the existing auto-send hero path.
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
  });
});
