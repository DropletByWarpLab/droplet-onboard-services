/**
 * WARP-1803 — the Home hero answers inline instead of navigating to /chat.
 *
 * Submitting the hero capsule (typed text or a suggestion chip) mounts the
 * inline conversation in the tile and sends the prompt through useChat with
 * the preferred model — it must NOT router.push("/chat") any more. The full
 * page stays reachable via "Open full chat" (`/chat?c=<id>`, enabled once
 * the server mints the conversation id), and "New chat" returns the tile to
 * the hero. The one legacy path kept: with no model configured the hero
 * still hands off via sessionStorage pendingPrompt + /chat navigation
 * (the chat page renders the model-selection empty state).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

// ── useChat mock — ref-overridable per test ──────────────────────────────
type ChatMsg = { id: string; role: "user" | "assistant"; content: string };
const sendMessageMock = vi.fn();
const stopMock = vi.fn();
const retryMessageMock = vi.fn();
const approveSceneMock = vi.fn();
const chatRef: {
  current: {
    conversationId: string | null;
    messages: ChatMsg[];
    isStreaming: boolean;
  };
} = { current: { conversationId: null, messages: [], isStreaming: false } };

vi.mock("@/lib/hooks/useChat", () => ({
  useChat: () => ({
    messages: chatRef.current.messages,
    isStreaming: chatRef.current.isStreaming,
    sendMessage: sendMessageMock,
    stop: stopMock,
    retryMessage: retryMessageMock,
    approveScene: approveSceneMock,
    conversationId: chatRef.current.conversationId,
  }),
}));

// ── useModels mock — ref-overridable (models list + household default) ───
const modelsRef: {
  current: {
    models: Array<{ id: string; provider: string; name: string }>;
    defaultModel: string | null;
  };
} = {
  current: {
    models: [{ id: "m1", provider: "ollama", name: "llama3.2" }],
    defaultModel: null,
  },
};
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

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
}));

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  useAuth: () => ({
    user: { id: "u1", username: "alice", displayName: "Alice" },
  }),
}));

// The real ChatMessage pulls the markdown/reasoning render stack — out of
// scope here. The mock surfaces role/content so thread rendering is visible.
vi.mock("@/components/ChatMessage", () => ({
  ChatMessage: ({
    message,
    isStreaming,
  }: {
    message: ChatMsg;
    isStreaming?: boolean;
  }) => (
    <div data-testid={`mock-msg-${message.role}`} data-streaming={isStreaming ? "1" : "0"}>
      {message.content}
    </div>
  ),
}));

import { WIDGETS } from "@/components/home/widgets";

const ChatTile = WIDGETS.chat.Comp;

function typeAndSubmit(text: string) {
  const box = screen.getByLabelText("Ask Droplet");
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
}

beforeEach(() => {
  cleanup();
  sendMessageMock.mockReset();
  stopMock.mockReset();
  retryMessageMock.mockReset();
  approveSceneMock.mockReset();
  pushMock.mockReset();
  chatRef.current = { conversationId: null, messages: [], isStreaming: false };
  modelsRef.current = {
    models: [{ id: "m1", provider: "ollama", name: "llama3.2" }],
    defaultModel: null,
  };
  window.sessionStorage.clear();
});

describe("WARP-1803 home hero inline chat", () => {
  it("submitting the capsule starts the conversation inline — no navigation", async () => {
    render(<ChatTile w={8} h={5} />);

    typeAndSubmit("what's on my network?");

    // The tile flipped to conversation mode and seeded the send.
    expect(screen.getByTestId("home-inline-thread")).toBeTruthy();
    await waitFor(() =>
      expect(sendMessageMock).toHaveBeenCalledWith(
        "what's on my network?",
        "m1",
        undefined,
        "ollama",
      ),
    );
    expect(pushMock).not.toHaveBeenCalled();
    // Nothing goes through the legacy sessionStorage hand-off.
    expect(window.sessionStorage.getItem("droplet.pendingPrompt")).toBeNull();
  });

  it("an empty submit is a no-op (no navigation, no send)", () => {
    render(<ChatTile w={8} h={5} />);

    fireEvent.keyDown(screen.getByLabelText("Ask Droplet"), { key: "Enter" });

    expect(screen.queryByTestId("home-inline-thread")).toBeNull();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("a suggestion chip starts the inline conversation with its prompt", async () => {
    render(<ChatTile w={8} h={5} />);

    fireEvent.click(
      screen.getByRole("button", { name: /What's using the most storage\?/ }),
    );

    expect(screen.getByTestId("home-inline-thread")).toBeTruthy();
    await waitFor(() =>
      expect(sendMessageMock).toHaveBeenCalledWith(
        "What's using the most storage?",
        "m1",
        undefined,
        "ollama",
      ),
    );
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("answers with the household default model when one is set (WARP-1112 order)", async () => {
    modelsRef.current = {
      models: [
        { id: "m1", provider: "ollama", name: "llama3.2" },
        { id: "m2", provider: "openai", name: "gpt-oss 20b" },
      ],
      defaultModel: "m2",
    };
    render(<ChatTile w={8} h={5} />);

    typeAndSubmit("hi");

    await waitFor(() =>
      expect(sendMessageMock).toHaveBeenCalledWith("hi", "m2", undefined, "openai"),
    );
  });

  it("renders the thread messages through ChatMessage", () => {
    chatRef.current = {
      conversationId: "conv-42",
      isStreaming: false,
      messages: [
        { id: "u1", role: "user", content: "what's on my network?" },
        { id: "a1", role: "assistant", content: "Twelve devices are online." },
      ],
    };
    render(<ChatTile w={8} h={5} />);
    typeAndSubmit("what's on my network?");

    expect(screen.getByTestId("mock-msg-user").textContent).toContain(
      "what's on my network?",
    );
    expect(screen.getByTestId("mock-msg-assistant").textContent).toContain(
      "Twelve devices are online.",
    );
  });

  it("'Open full chat' is disabled until the conversation id mints", () => {
    chatRef.current = { conversationId: null, messages: [], isStreaming: false };
    render(<ChatTile w={8} h={5} />);
    typeAndSubmit("hello");

    const open = screen.getByRole("button", { name: /Open full chat/ });
    expect((open as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(open);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("'Open full chat' deep-links to /chat?c=<id> once the id exists", () => {
    chatRef.current = { conversationId: "conv-42", messages: [], isStreaming: false };
    render(<ChatTile w={8} h={5} />);
    typeAndSubmit("hello");

    fireEvent.click(screen.getByRole("button", { name: /Open full chat/ }));
    expect(pushMock).toHaveBeenCalledWith("/chat?c=conv-42");
  });

  it("'New chat' returns the tile to the hero", () => {
    render(<ChatTile w={8} h={5} />);
    typeAndSubmit("hello");
    expect(screen.getByTestId("home-inline-thread")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /New chat/ }));

    expect(screen.queryByTestId("home-inline-thread")).toBeNull();
    // The greeting display is back.
    expect(screen.getByText(/What can I/)).toBeTruthy();
  });

  it("while streaming, the composer shows Stop and follow-up sends are held", () => {
    chatRef.current = { conversationId: "conv-42", messages: [], isStreaming: true };
    render(<ChatTile w={8} h={5} />);
    typeAndSubmit("hello");
    sendMessageMock.mockClear(); // drop the mount seed call

    const stop = screen.getByTitle("Stop");
    fireEvent.click(stop);
    expect(stopMock).toHaveBeenCalled();

    // Enter during a stream must not fire another send.
    typeAndSubmit("follow-up while streaming");
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("keeps the legacy pendingPrompt hand-off when no model is configured", () => {
    modelsRef.current = { models: [], defaultModel: null };
    render(<ChatTile w={8} h={5} />);

    typeAndSubmit("summarize my notes");

    expect(window.sessionStorage.getItem("droplet.pendingPrompt")).toBe(
      "summarize my notes",
    );
    expect(pushMock).toHaveBeenCalledWith("/chat");
    expect(screen.queryByTestId("home-inline-thread")).toBeNull();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
