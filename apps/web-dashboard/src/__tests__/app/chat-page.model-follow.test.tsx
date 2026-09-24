/**
 * WARP-3048 — /chat follows the box's active model, but never moves a
 * thread or overrides the user.
 *
 * The page used to auto-select only while nothing was selected, so its
 * FIRST answer stuck: a switch on /models (or a stale cached defaultModel on
 * a client-side visit) never reached the composer, and "New chat" kept the
 * old pick. These tests drive the selection source: 'auto' follows
 * defaultModel while the chat is fresh; a user pick and a reopened thread
 * do not follow it; New chat goes back to 'auto'; a model that leaves the
 * list falls back.
 *
 * NB: a <select> whose value matches no option DISPLAYS its first option,
 * so every expectation below names a model that is not first in the list
 * — or checks the model a send actually carries.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";

type ChatMsg = { id: string; role: "user" | "assistant"; content: string };
type Model = { id: string; provider: string; name: string };

// ── useChat mock — ref-overridable; captures the page's options so a test
// can fire onConversationLoaded like a real thread load does. ──────────────
const clearMessagesMock = vi.fn();
const sendMessageMock = vi.fn();
const chatRef: {
  current: { conversationId: string | null; messages: ChatMsg[] };
} = { current: { conversationId: null, messages: [] } };
const chatOptsRef: {
  current: { onConversationLoaded?: (c: { model: string | null; systemPrompt: string | null }) => void };
} = { current: {} };

vi.mock("@/lib/hooks/useChat", () => ({
  useChat: (opts: typeof chatOptsRef.current) => {
    chatOptsRef.current = opts;
    return {
      messages: chatRef.current.messages,
      isStreaming: false,
      sendMessage: sendMessageMock,
      stop: vi.fn(),
      retryMessage: vi.fn(),
      regenerate: vi.fn(),
      clearMessages: clearMessagesMock,
      attachments: [],
      sessionAttachments: [],
      attach: vi.fn(),
      removeAttachment: vi.fn(),
      clearAttachments: vi.fn(),
      conversationId: chatRef.current.conversationId,
      loadConversation: vi.fn().mockResolvedValue(true),
      messagesEpoch: 0,
    };
  },
}));

// ── useModels mock — the list and the household default, per test ────────
const modelsRef: {
  current: { models: Model[]; defaultModel: string | null; isLoading?: boolean };
} = { current: { models: [], defaultModel: null } };
vi.mock("@/lib/hooks/useModels", () => ({
  useModels: () => modelsRef.current,
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

// A loaded thread carries `?c=<id>` in the real app; without it the page's
// URL→state effect would (correctly) treat the thread as abandoned.
const searchParamsRef: { current: URLSearchParams } = {
  current: new URLSearchParams(),
};
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => searchParamsRef.current,
  usePathname: () => "/chat",
}));

/** An open, in-progress thread `c1` with one user turn. */
function openThread() {
  searchParamsRef.current = new URLSearchParams("c=c1");
  chatRef.current = {
    conversationId: "c1",
    messages: [{ id: "m1", role: "user", content: "hello" }],
  };
}

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  useAuth: () => ({
    user: { id: "u1", username: "alice", displayName: "Alice" },
  }),
}));

import ChatPage from "@/app/chat/page";

const A: Model = { id: "model-a", provider: "local", name: "Model A" };
const B: Model = { id: "model-b", provider: "local", name: "Model B" };
const C: Model = { id: "model-c", provider: "local", name: "Model C" };

function picker(): HTMLSelectElement {
  return screen.getByRole("combobox", { name: "Model" }) as HTMLSelectElement;
}

beforeEach(() => {
  cleanup();
  sendMessageMock.mockReset();
  clearMessagesMock.mockReset().mockImplementation(() => {
    chatRef.current = { conversationId: null, messages: [] };
  });
  chatRef.current = { conversationId: null, messages: [] };
  searchParamsRef.current = new URLSearchParams();
  chatOptsRef.current = {};
  modelsRef.current = { models: [A, B, C], defaultModel: "model-a" };
  window.sessionStorage.clear();
});

describe("/chat model selection source (WARP-3048)", () => {
  it("a fresh chat follows a defaultModel change (A → B) with no reload", async () => {
    const { rerender } = render(<ChatPage />);
    await waitFor(() => expect(picker().value).toBe("model-a"));

    // The owner switched the active model on /models; the list refetched.
    modelsRef.current = { models: [A, B, C], defaultModel: "model-b" };
    rerender(<ChatPage />);

    await waitFor(() => expect(picker().value).toBe("model-b"));
  });

  it("never overrides the user's own pick when defaultModel changes", async () => {
    const { rerender } = render(<ChatPage />);
    await waitFor(() => expect(picker().value).toBe("model-a"));

    fireEvent.change(picker(), { target: { value: "model-c" } });
    await waitFor(() => expect(picker().value).toBe("model-c"));

    modelsRef.current = { models: [A, B, C], defaultModel: "model-b" };
    rerender(<ChatPage />);

    // Give the effect a render to act, then assert it did not.
    await act(async () => {});
    expect(picker().value).toBe("model-c");
  });

  it("never moves an in-progress thread, even one the user never picked for", async () => {
    openThread();
    const { rerender } = render(<ChatPage />);
    await waitFor(() => expect(picker().value).toBe("model-a"));

    modelsRef.current = { models: [A, B, C], defaultModel: "model-b" };
    rerender(<ChatPage />);

    await act(async () => {});
    expect(picker().value).toBe("model-a");
  });

  it("New chat resets a user pick back to the active model", async () => {
    openThread();
    const { rerender } = render(<ChatPage />);
    await waitFor(() => expect(picker().value).toBe("model-a"));
    fireEvent.change(picker(), { target: { value: "model-c" } });
    await waitFor(() => expect(picker().value).toBe("model-c"));

    // Meanwhile the owner made B the active model.
    modelsRef.current = { models: [A, B, C], defaultModel: "model-b" };
    rerender(<ChatPage />);
    await act(async () => {});
    expect(picker().value).toBe("model-c");

    fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));

    expect(clearMessagesMock).toHaveBeenCalled();
    await waitFor(() => expect(picker().value).toBe("model-b"));
  });

  it("a restored conversation keeps its model when defaultModel changes", async () => {
    const { rerender } = render(<ChatPage />);
    await waitFor(() => expect(picker().value).toBe("model-a"));

    // A thread loads (sidebar / deep link), held on model C.
    openThread();
    act(() => {
      chatOptsRef.current.onConversationLoaded?.({
        model: "model-c",
        systemPrompt: null,
      });
    });
    await waitFor(() => expect(picker().value).toBe("model-c"));

    modelsRef.current = { models: [A, B, C], defaultModel: "model-b" };
    rerender(<ChatPage />);
    await act(async () => {});
    expect(picker().value).toBe("model-c");
  });

  it("falls back to the active model when the selected one leaves the list", async () => {
    modelsRef.current = { models: [A, B, C], defaultModel: "model-b" };
    const { rerender } = render(<ChatPage />);
    await waitFor(() => expect(picker().value).toBe("model-b"));
    fireEvent.change(picker(), { target: { value: "model-c" } });
    await waitFor(() => expect(picker().value).toBe("model-c"));

    // Model C was removed (or its cloud key revoked).
    modelsRef.current = { models: [A, B], defaultModel: "model-b" };
    rerender(<ChatPage />);

    await waitFor(() => expect(picker().value).toBe("model-b"));
    // And a send really carries the fallback, not the vanished model.
    fireEvent.click(screen.getByRole("button", { name: "What's using the most storage?" }));
    expect(sendMessageMock).toHaveBeenCalledWith(
      "What's using the most storage?",
      "model-b",
      undefined,
      "local",
    );
  });
});

describe("/chat single-model box and empty state (WARP-3048)", () => {
  it("shows a read-only model chip that links to /models", async () => {
    modelsRef.current = { models: [A], defaultModel: "model-a" };
    render(<ChatPage />);

    const chip = await screen.findByRole("link", {
      name: "Model: Model A — manage on Models",
    });
    expect(chip).toHaveAttribute("href", "/models");
    expect(screen.queryByRole("combobox", { name: "Model" })).toBeNull();
  });

  it("names the real state instead of pointing at a picker 'above'", async () => {
    modelsRef.current = { models: [], defaultModel: null, isLoading: false };
    render(<ChatPage />);

    expect(screen.queryByText(/select a model above/i)).toBeNull();
    expect(
      screen.getByText(/no ai model is ready on this droplet yet/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "see Models" })).toHaveAttribute(
      "href",
      "/models",
    );
  });
});
