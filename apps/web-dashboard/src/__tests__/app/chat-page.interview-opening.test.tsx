/**
 * WARP-1121 — regression: starting the business walkthrough must ASK
 * something.
 *
 * Bug (Stefan, 2026-09-03): "the business walkthrough on the llm page takes
 * you back to a chat rather than running through the questions". Clicking
 * `Run business setup` in Settings (or `Start` on the chat intro card) moved
 * the state to `in_progress`, created a persisted ChatSession and navigated
 * to it — and that was all. The session was EMPTY, and `/llm/chat` refuses a
 * thread with no user turn (`empty_replay`), so the model could not open the
 * conversation either. What the owner got was the generic chat empty state —
 * "Ask Droplet anything" with four unrelated suggestion prompts — under a
 * progress eyebrow frozen at 0 of 7. No question, no topics, no walkthrough.
 *
 * Fix, two halves:
 *   1. the orchestrator seeds the marker-carrying opening turn into the
 *      session inside `startOnboarding` (server-authored, exactly like
 *      CLOSING_TURN) — asserted in business-onboarding.service.test.ts;
 *   2. /chat never paints the generic empty state inside the interview
 *      session — asserted here, along with the shaping of the seeded turn.
 *
 * The mocks are keyed off a mutable `state` so both halves render the REAL
 * page component rather than a second implementation of its conditions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

const INTERVIEW_CHAT_ID = "conv-interview-fresh";

// The server-authored opener, verbatim as the orchestrator seeds it. Kept as
// a literal (not imported from the backend package) so a copy change on
// either side is a visible diff on both.
const OPENING_TURN =
  "[topic 1/7] To start — in a sentence or two, what does your business do?";

const { state } = vi.hoisted(() => ({
  state: {
    messages: [] as Array<{ id: string; role: string; content: string }>,
  },
}));

vi.mock("@/lib/hooks/useChat", () => ({
  useChat: () => ({
    messages: state.messages,
    isStreaming: false,
    sendMessage: vi.fn(),
    stop: vi.fn(),
    retryMessage: vi.fn(),
    regenerate: vi.fn(),
    editMessage: vi.fn(),
    rateMessage: vi.fn(),
    approveScene: vi.fn(),
    clearMessages: vi.fn(),
    attachments: [],
    sessionAttachments: [],
    attach: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    // The interview session is OPEN — this is the state the owner lands in
    // one navigation after clicking Start.
    conversationId: INTERVIEW_CHAT_ID,
    loadConversation: vi.fn(async () => true),
    messagesEpoch: 0,
  }),
}));

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

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  useAuth: () => ({
    user: { id: "u1", username: "alice", displayName: "Alice", role: "owner" },
  }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchBusinessProfile: vi.fn(async () => ({
      onboardingState: "in_progress",
      interviewChatId: INTERVIEW_CHAT_ID,
      interviewResumable: true,
      workspaceType: "BUSINESS",
    })),
  };
});

import ChatPage from "@/app/chat/page";

describe("chat /chat — a started interview opens with its first question", () => {
  beforeEach(() => {
    state.messages = [];
  });
  afterEach(() => cleanup());

  it("renders the seeded opening question with its topic marker stripped", async () => {
    state.messages = [{ id: "a-0", role: "assistant", content: OPENING_TURN }];

    render(<ChatPage />);

    // The question is on screen…
    expect(
      await screen.findByText(
        /in a sentence or two, what does your business do\?/i,
      ),
    ).toBeTruthy();
    // …and the machine-readable marker is not (§9.3 — the client strips it).
    expect(screen.queryByText(/\[topic 1\/7\]/)).toBeNull();
  });

  it("advances the progress eyebrow to topic 1 off the seeded marker", async () => {
    state.messages = [{ id: "a-0", role: "assistant", content: OPENING_TURN }];

    render(<ChatPage />);

    const dot = await screen.findByTestId("topic-dot-1");
    await waitFor(() => expect(dot.getAttribute("data-done")).toBe("true"));
    // Dot 2 is still to come — the marker protocol never runs ahead.
    expect(screen.getByTestId("topic-dot-2").getAttribute("data-done")).toBe(
      "false",
    );
  });

  it("never paints the generic chat empty state inside the interview session", async () => {
    // The pre-fix surface, reproduced exactly: interview session open,
    // transcript not (yet) there. Even in this frame the owner must not be
    // offered "Ask Droplet anything" and four off-topic prompts — that is
    // the "it dropped me back into a chat" report.
    state.messages = [];

    render(<ChatPage />);

    // The interview chrome proves the page settled into the interview…
    expect(await screen.findByTestId("interview-progress")).toBeTruthy();
    // …and the generic chat empty state is absent.
    expect(screen.queryByText("Ask Droplet anything")).toBeNull();
  });
});
