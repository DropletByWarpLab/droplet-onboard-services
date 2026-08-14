import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const listConversationsMock = vi.fn();
const renameConversationMock = vi.fn();
const deleteConversationMock = vi.fn();
const fetchConversationMock = vi.fn();
const setConversationPinnedMock = vi.fn();

vi.mock("@/lib/api", () => ({
  listConversations: (...a: unknown[]) => listConversationsMock(...a),
  renameConversation: (...a: unknown[]) => renameConversationMock(...a),
  deleteConversation: (...a: unknown[]) => deleteConversationMock(...a),
  fetchConversation: (...a: unknown[]) => fetchConversationMock(...a),
  setConversationPinned: (...a: unknown[]) => setConversationPinnedMock(...a),
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
  setConversationPinnedMock.mockReset();
});

const row = (
  id: string,
  daysAgo = 0,
  title: string | null = `chat-${id}`,
  extra: { pinned?: boolean; pinnedAt?: string | null } = {},
) => {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return {
    id,
    title,
    model: "llama3",
    provider: "ollama",
    pinned: false,
    pinnedAt: null as string | null,
    createdAt: d.toISOString(),
    updatedAt: d.toISOString(),
    ...extra,
  };
};

/** Hours-ago ISO stamp for pinnedAt ordering fixtures. */
const hoursAgo = (h: number) =>
  new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

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

  // ── WARP-1917 — pinned chats ─────────────────────────────────────────────

  it("renders a Pinned section above the date groups, ordered by pinnedAt desc, without duplicating rows", async () => {
    listConversationsMock.mockResolvedValue([
      row("a", 0), // today, unpinned
      row("b", 1, undefined, { pinned: true, pinnedAt: hoursAgo(5) }), // yesterday, pinned earlier
      row("c", 10, undefined, { pinned: true, pinnedAt: hoursAgo(1) }), // old, pinned most recently
      row("d", 10), // old, unpinned
    ]);
    render(
      <ChatHistoryPanel
        activeConversationId={null}
        onSelect={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("chat-a")).toBeInTheDocument());

    // Section exists and sits ABOVE the first date group in the DOM.
    const pinnedCap = screen.getByText("Pinned");
    const todayCap = screen.getByText("Today");
    expect(
      pinnedCap.compareDocumentPosition(todayCap) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Most recent pin first: c (1h ago) before b (5h ago) — NOT activity order.
    const section = pinnedCap.closest(".conv-group") as HTMLElement;
    const titles = Array.from(section.querySelectorAll(".conv-it-t")).map(
      (el) => el.textContent,
    );
    expect(titles).toEqual(["chat-c", "chat-b"]);

    // Pinned rows do NOT also render in their date groups: b was the only
    // "Yesterday" chat, so that header must be gone entirely, and each
    // pinned title appears exactly once in the whole panel.
    expect(screen.queryByText("Yesterday")).toBeNull();
    expect(screen.getAllByText("chat-b")).toHaveLength(1);
    expect(screen.getAllByText("chat-c")).toHaveLength(1);
    // Unpinned rows keep their chronological groups.
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Previous 30 days")).toBeInTheDocument();
    expect(screen.getByText("chat-d")).toBeInTheDocument();
  });

  it("pins a chat from the row menu (optimistic move into Pinned)", async () => {
    listConversationsMock.mockResolvedValue([row("a", 0)]);
    setConversationPinnedMock.mockResolvedValue(undefined);
    render(
      <ChatHistoryPanel
        activeConversationId={null}
        onSelect={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("chat-a")).toBeInTheDocument());
    expect(screen.queryByText("Pinned")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^pin$/i }));

    expect(setConversationPinnedMock).toHaveBeenCalledWith("a", true);
    // Optimistic: the section appears without waiting for the server.
    expect(screen.getByText("Pinned")).toBeInTheDocument();
    const section = screen.getByText("Pinned").closest(".conv-group")!;
    expect(section.textContent).toContain("chat-a");
    // No duplicate left behind in the date groups.
    expect(screen.getAllByText("chat-a")).toHaveLength(1);
  });

  it("unpin returns the chat to its chronological group", async () => {
    listConversationsMock.mockResolvedValue([
      row("a", 1, undefined, { pinned: true, pinnedAt: hoursAgo(2) }),
    ]);
    setConversationPinnedMock.mockResolvedValue(undefined);
    render(
      <ChatHistoryPanel
        activeConversationId={null}
        onSelect={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("chat-a")).toBeInTheDocument());
    expect(screen.getByText("Pinned")).toBeInTheDocument();
    expect(screen.queryByText("Yesterday")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /unpin/i }));

    expect(setConversationPinnedMock).toHaveBeenCalledWith("a", false);
    // Back to the chronological bucket its updatedAt puts it in.
    expect(screen.queryByText("Pinned")).toBeNull();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
    expect(screen.getAllByText("chat-a")).toHaveLength(1);
  });

  it("rolls the pin back when the server rejects it", async () => {
    listConversationsMock.mockResolvedValue([row("a", 0)]);
    setConversationPinnedMock.mockRejectedValue(new Error("boom"));
    render(
      <ChatHistoryPanel
        activeConversationId={null}
        onSelect={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("chat-a")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^pin$/i }));

    // Optimistic flip, then rollback once the PATCH fails.
    expect(screen.getByText("Pinned")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Pinned")).toBeNull());
    expect(screen.getByText("chat-a")).toBeInTheDocument();
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
