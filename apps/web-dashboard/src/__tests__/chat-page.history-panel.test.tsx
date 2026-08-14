import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";

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

// DASH-04: the chat page reads useAuth().user to gate the chat WS bridge.
// Preserve the real module (api.ts imports authFetch/patchSetupReady from it)
// and only override useAuth to report a logged-in user so the page renders.
vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>(
    "@/lib/auth",
  );
  return {
    ...actual,
    useAuth: () => ({
      user: { id: "u1", username: "alice", displayName: "Alice" },
    }),
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

  // WARP-1787: the drawer is a full-width sheet below 720px, so there is no
  // backdrop strip left to tap and a phone has no Escape key. The rail's
  // header Close button is the only remaining way out.
  it("closes the mobile history drawer from its own header button", async () => {
    render(<ChatPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /open chat history/i }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^close$/i }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
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
      expect(screen.getAllByText(/hello from a prior turn/i).length).toBeGreaterThan(0),
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

    // Deflake: the composer's model selector hydrates asynchronously (useModels),
    // and the resend is a no-op until a model is selected — so clicking too early
    // calls sendChat 0 times. Wait for the on-device model tag, which only renders
    // once a local model is selected, before clicking Try-again.
    await waitFor(
      () => expect(screen.getByText(/on-device/i)).toBeInTheDocument(),
      { timeout: 10000 },
    );

    // Click Try-again until the retry engages (WARP-853). On starved CI
    // workers this click intermittently no-oped (sendChat stayed at 0 for
    // the full 10s window; runs 27303654088 / 27306872609 / 27309429060)
    // while passing locally even under artificial CPU load — consistent
    // with a late async settle re-rendering the chip between the query and
    // the click, so the event lands on a detached node React never sees.
    // Re-querying and re-clicking inside the poll makes the click land on
    // the LIVE node deterministically; it can't double-fire because a
    // successful retry synchronously drops the failed turn (the chip —
    // and its button — unmount within the same act flush).
    await waitFor(
      () => {
        const tryAgain = screen.queryByRole("button", {
          name: /try sending this message again/i,
        });
        if (tryAgain) fireEvent.click(tryAgain);
        // sendChat was called once, with the right replay shape.
        expect(sendChatMock).toHaveBeenCalledTimes(1);
      },
      { timeout: 10000 },
    );
    const replay = sendChatMock.mock.calls[0][0].messages;
    expect(replay.at(-1)).toEqual({ role: "user", content: "what time is it" });
    // Slower CI runners need more than waitFor's 1s default for the
    // click -> retryMessage -> sendMessage -> sendChat async chain.
  }, 30000);
});
