import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

// Mock api so the page renders without hitting the network.
const listConversationsMock = vi.fn().mockResolvedValue([]);
const fetchConversationMock = vi.fn();
const sendChatMock = vi.fn();
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    listConversations: (...a: unknown[]) => listConversationsMock(...a),
    fetchConversation: (...a: unknown[]) => fetchConversationMock(...a),
    sendChat: (...a: unknown[]) => sendChatMock(...a),
    fetchModels: vi.fn().mockResolvedValue({ models: [] }),
  };
});

// Mock useModels directly so the Try-again integration test can guarantee
// `selectedModel` is populated synchronously (the SWR pathway through
// fetchModels can lag the first render and leave selectedModel empty,
// turning handleRetry into a no-op).
const modelsRef: { current: { id: string; provider: string }[] } = {
  current: [],
};
vi.mock("@/lib/hooks/useModels", () => ({
  useModels: () => ({ models: modelsRef.current }),
}));

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
  sendChatMock.mockReset();
  pushMock.mockReset();
  searchParamsRef.current = new URLSearchParams();
  modelsRef.current = [];
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

  it("renders the FailureChip for a loaded failed turn and Try-again re-sends", async () => {
    searchParamsRef.current = new URLSearchParams("c=conv-failed");
    modelsRef.current = [{ id: "llama3", provider: "ollama" }];
    fetchConversationMock.mockResolvedValueOnce({
      id: "conv-failed",
      title: "Failed",
      model: "llama3",
      provider: "ollama",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        {
          id: "u1",
          role: "user",
          content: "what time is it",
          toolCalls: null,
          toolCallId: null,
          turnId: "t1",
          status: "completed",
          createdAt: new Date().toISOString(),
        },
        {
          id: "a1",
          role: "assistant",
          content: "",
          toolCalls: null,
          toolCallId: null,
          turnId: "t1",
          status: "failed",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    sendChatMock.mockResolvedValue({
      headers: new Headers({ "x-conversation-id": "conv-failed" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `event: done\ndata: {"iterations":1,"stop_reason":"model_done"}\n\n`,
            ),
          );
          controller.close();
        },
      }),
    });

    render(<ChatPage />);

    await waitFor(() =>
      expect(fetchConversationMock).toHaveBeenCalledWith("conv-failed"),
    );

    // FailureChip is visible.
    await waitFor(() =>
      expect(
        screen.getByText("Something went wrong on this turn."),
      ).toBeInTheDocument(),
    );

    // Click Try-again.
    fireEvent.click(
      screen.getByRole("button", { name: /try sending this message again/i }),
    );

    // sendChat was called once, with the right replay shape.
    await waitFor(() => expect(sendChatMock).toHaveBeenCalledTimes(1));
    const replay = sendChatMock.mock.calls[0][0].messages;
    expect(replay.at(-1)).toEqual({ role: "user", content: "what time is it" });
  });
});
