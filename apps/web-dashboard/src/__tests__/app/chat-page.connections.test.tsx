import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChatMessage as Message } from "@/lib/types";

const send = vi.fn();
const state = { messages: [] as Message[], conversationId: "chat-one" as string | null, messagesEpoch: 0, isStreaming: false };
vi.mock("@/lib/hooks/useChat", () => ({ useChat: () => ({ ...state, sendMessage: send, stop: vi.fn(), retryMessage: vi.fn(), regenerate: vi.fn(), approveScene: vi.fn(), clearMessages: vi.fn(), loadConversation: vi.fn(), attachments: [], sessionAttachments: [], attach: vi.fn(), removeAttachment: vi.fn(), clearAttachments: vi.fn() }) }));
vi.mock("@/lib/hooks/useModels", () => ({ useModels: () => ({ models: [{ id: "m1", provider: "ollama" }] }) }));
vi.mock("@/lib/hooks/useStickyScroll", () => ({ useStickyScroll: () => ({ scrollRef: { current: null }, isDetached: false, scrollToBottom: vi.fn(), onScroll: vi.fn(), stickyScrollToBottom: vi.fn() }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams(), usePathname: () => "/chat" }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "owner", role: "owner" } }), authFetch: vi.fn() }));
vi.mock("@/components/ChatMessage", () => ({ ChatMessage: ({ message, connectionSetupInteractive, onConnectionOutcome }: { message: Message; connectionSetupInteractive?: boolean; onConnectionOutcome?: (turn: string) => void }) => <button data-testid={message.id} data-interactive={String(connectionSetupInteractive)} onClick={() => onConnectionOutcome?.("Google is connected.")}>{message.content}</button> }));
import ChatPage from "@/app/chat/page";

beforeEach(() => {
  cleanup(); send.mockReset(); sessionStorage.clear();
  Object.assign(state, { messages: [], conversationId: "chat-one", messagesEpoch: 0, isStreaming: false });
});

describe("chat connection setup lifecycle", () => {
  it("keeps the setup component mounted when the stream replaces its assistant message id", () => {
    const view = render(<ChatPage />);
    const toolCalls = [{ id: "setup-call", name: "start_connection", args: { service: "google" }, ok: true }];
    state.messages = [{ id: "temporary", role: "assistant", content: "Google setup", toolCalls }];
    view.rerender(<ChatPage />);
    const setup = screen.getByTestId("temporary");
    state.messages = [{ ...state.messages[0], id: "persisted" }];
    view.rerender(<ChatPage />);
    expect(screen.getByTestId("persisted")).toBe(setup);
    expect(screen.getByTestId("persisted")).toHaveAttribute("data-interactive", "true");
  });
  it("keeps existing composer controls and restricts setup to live newest messages", async () => {
    state.messages = [{ id: "history", role: "assistant", content: "Prior connection" }];
    const view = render(<ChatPage />);
    expect(screen.getByTestId("history")).toHaveAttribute("data-interactive", "false");
    expect(screen.queryByRole("button", { name: /^connections$/i })).not.toBeInTheDocument();
    state.messages = [...state.messages, { id: "live", role: "assistant", content: "Current setup" }];
    view.rerender(<ChatPage />);
    expect(screen.getByTestId("live")).toHaveAttribute("data-interactive", "true");
    state.messages = [...state.messages, { id: "next-user", role: "user", content: "Next request" }];
    view.rerender(<ChatPage />);
    expect(screen.getByTestId("live")).toHaveAttribute("data-interactive", "false");
    state.messagesEpoch += 1;
    state.messages = [{ id: "loaded", role: "assistant", content: "Restored setup" }];
    view.rerender(<ChatPage />);
    expect(screen.getByTestId("loaded")).toHaveAttribute("data-interactive", "false");
  });

  it("queues verified setup outcomes until streaming ends and preserves the draft", async () => {
    sessionStorage.setItem("droplet.chatDraft", "Continue writing this draft");
    const view = render(<ChatPage />);
    state.messages = [{ id: "live", role: "assistant", content: "Google setup" }];
    state.isStreaming = true;
    view.rerender(<ChatPage />);
    fireEvent.click(screen.getByTestId("live"));
    expect(send).not.toHaveBeenCalled();
    state.isStreaming = false;
    view.rerender(<ChatPage />);
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send).toHaveBeenCalledWith("Google is connected.", "m1", undefined, "ollama", { preserveComposerAttachments: true });
    expect(screen.getByPlaceholderText("Ask Droplet anything…")).toHaveValue("Continue writing this draft");
  });

  it("discards a pending setup outcome when switching chats", async () => {
    const view = render(<ChatPage />);
    state.messages = [{ id: "live", role: "assistant", content: "Google setup" }];
    state.isStreaming = true;
    view.rerender(<ChatPage />);
    fireEvent.click(screen.getByTestId("live"));
    state.conversationId = "chat-two";
    state.messagesEpoch += 1;
    state.isStreaming = false;
    view.rerender(<ChatPage />);
    await act(async () => {});
    expect(send).not.toHaveBeenCalled();
  });
});
