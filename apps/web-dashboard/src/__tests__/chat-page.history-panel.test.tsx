import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// Mock api so the page renders without hitting the network.
const listConversationsMock = vi.fn().mockResolvedValue([]);
const fetchConversationMock = vi.fn();
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    listConversations: (...a: unknown[]) => listConversationsMock(...a),
    fetchConversation: (...a: unknown[]) => fetchConversationMock(...a),
    fetchModels: vi.fn().mockResolvedValue([]),
  };
});

// next/navigation mocks — per-file override so we can drive useSearchParams
// to simulate the panel pushing different ?c=<id> values across renders.
const pushMock = vi.fn();
const searchParamsRef: { current: URLSearchParams } = {
  current: new URLSearchParams(),
};
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  useSearchParams: () => searchParamsRef.current,
  usePathname: () => "/chat",
}));

import ChatPage from "@/app/chat/page";

beforeEach(() => {
  listConversationsMock.mockReset().mockResolvedValue([]);
  fetchConversationMock.mockReset();
  pushMock.mockReset();
  searchParamsRef.current = new URLSearchParams();
});

describe("/chat page mounts the history panel", () => {
  it("renders the desktop chat-history aside and the empty-state copy", async () => {
    render(<ChatPage />);
    expect(
      screen.getByRole("complementary", { name: /chat history/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /open chat history/i }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/no chats yet/i)).toBeInTheDocument(),
    );
  });

  it("loads the conversation referenced by ?c=<id> on mount", async () => {
    searchParamsRef.current = new URLSearchParams("c=abc-123");
    fetchConversationMock.mockResolvedValue({
      id: "abc-123",
      title: "Persisted chat",
      model: "llama3",
      provider: "ollama",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        {
          id: "m1",
          role: "user",
          content: "hello from a prior turn",
          toolCalls: null,
          toolCallId: null,
          turnId: "t1",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    render(<ChatPage />);
    await waitFor(() =>
      expect(fetchConversationMock).toHaveBeenCalledWith("abc-123"),
    );
    // The hydrated user message renders in the message column.
    await waitFor(() =>
      expect(screen.getByText(/hello from a prior turn/i)).toBeInTheDocument(),
    );
  });
});
