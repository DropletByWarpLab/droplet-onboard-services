import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const listConversationsMock = vi.fn();
const renameConversationMock = vi.fn();
const deleteConversationMock = vi.fn();
const fetchConversationMock = vi.fn();

vi.mock("@/lib/api", () => ({
  listConversations: (...a: unknown[]) => listConversationsMock(...a),
  renameConversation: (...a: unknown[]) => renameConversationMock(...a),
  deleteConversation: (...a: unknown[]) => deleteConversationMock(...a),
  fetchConversation: (...a: unknown[]) => fetchConversationMock(...a),
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// jsdom does not implement IntersectionObserver — shim with a no-op so
// the component's sentinel useEffect doesn't throw.
if (typeof globalThis.IntersectionObserver === "undefined") {
  globalThis.IntersectionObserver = class IntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
}

import { ChatHistoryPanel } from "./ChatHistoryPanel";

beforeEach(() => {
  listConversationsMock.mockReset();
  renameConversationMock.mockReset();
  deleteConversationMock.mockReset();
  fetchConversationMock.mockReset();
});

const row = (id: string, daysAgo = 0, title: string | null = `chat-${id}`) => {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return {
    id,
    title,
    model: "llama3",
    provider: "ollama",
    createdAt: d.toISOString(),
    updatedAt: d.toISOString(),
  };
};

describe("ChatHistoryPanel", () => {
  it("shows the empty state when there are no conversations", async () => {
    listConversationsMock.mockResolvedValue([]);
    render(
      <ChatHistoryPanel
        activeConversationId={null}
        onSelect={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText(/no chats yet/i)).toBeInTheDocument());
  });

  it("renders date group headers and rows", async () => {
    listConversationsMock.mockResolvedValue([row("a", 0), row("b", 1), row("c", 10)]);
    render(
      <ChatHistoryPanel
        activeConversationId={null}
        onSelect={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("chat-a")).toBeInTheDocument());
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
    expect(screen.getByText("Previous 30 days")).toBeInTheDocument();
  });

  it("fires onSelect with the row id", async () => {
    const onSelect = vi.fn();
    listConversationsMock.mockResolvedValue([row("a")]);
    render(
      <ChatHistoryPanel
        activeConversationId={null}
        onSelect={onSelect}
        onNewChat={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("chat-a")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /open chat/i }));
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("fires onNewChat from the + New chat button", async () => {
    const onNewChat = vi.fn();
    listConversationsMock.mockResolvedValue([]);
    render(
      <ChatHistoryPanel
        activeConversationId={null}
        onSelect={vi.fn()}
        onNewChat={onNewChat}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /new chat/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /new chat/i }));
    expect(onNewChat).toHaveBeenCalled();
  });

  // ── WARP-1787 ───────────────────────────────────────────────────────────
  // The panel is the body of BOTH the desktop rail and the /chat mobile
  // drawer. Only the drawer has something to close, so the control is opt-in:
  // a Close button on the always-mounted desktop rail would do nothing.
  it("renders no Close control for the desktop rail", async () => {
    listConversationsMock.mockResolvedValue([]);
    render(
      <ChatHistoryPanel
        activeConversationId={null}
        onSelect={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText(/no chats yet/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /^close$/i })).toBeNull();
  });

  it("renders a Close control in the header when onClose is provided", async () => {
    const onClose = vi.fn();
    listConversationsMock.mockResolvedValue([]);
    render(
      <ChatHistoryPanel
        activeConversationId={null}
        onSelect={vi.fn()}
        onNewChat={vi.fn()}
        onClose={onClose}
      />,
    );
    const close = await screen.findByRole("button", { name: /^close$/i });
    // In the header row, where every other side panel puts it.
    expect(close.closest(".conv-head")).not.toBeNull();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalled();
  });

  it("confirms before deleting and calls deleteConversation on confirm", async () => {
    listConversationsMock.mockResolvedValue([row("a")]);
    deleteConversationMock.mockResolvedValue(true);
    render(
      <ChatHistoryPanel
        activeConversationId={null}
        onSelect={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("chat-a")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /delete/i }));
    expect(screen.getByText(/delete this chat/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(deleteConversationMock).toHaveBeenCalledWith("a"));
  });

  it("calls onNewChat after deleting the currently-active conversation", async () => {
    const onNewChat = vi.fn();
    listConversationsMock.mockResolvedValue([row("a")]);
    deleteConversationMock.mockResolvedValue(true);
    render(
      <ChatHistoryPanel
        activeConversationId="a"
        onSelect={vi.fn()}
        onNewChat={onNewChat}
      />,
    );
    await waitFor(() => expect(screen.getByText("chat-a")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /delete/i }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(onNewChat).toHaveBeenCalled());
  });
});
