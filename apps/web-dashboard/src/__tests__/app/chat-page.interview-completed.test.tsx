/**
 * WARP-1121 — regression: a COMPLETED onboarding-interview session must keep
 * its special message shaping.
 *
 * Bug (Romain, PR #949): the interview turn shaping in /chat — the ReviewCard
 * for the fenced JSON proposal and the stripping of `[topic n/7]` markers —
 * was gated on `interviewActive`, which flips FALSE the moment
 * `onboardingState` settles to "completed". So after the user clicked Apply
 * (or on any later reopen of the finished session), the stored proposal
 * leaked as RAW fenced JSON and the questions showed their `[topic n/7]`
 * markers as plain text.
 *
 * Fix: the message shaping keys off whether the open conversation IS the
 * interview session (`interviewChatId === conversationId`) — true across the
 * whole lifecycle including "completed" — instead of the live-active flag.
 * The active-only chrome (progress dots, chips) stays gated on
 * `interviewActive`.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const INTERVIEW_CHAT_ID = "conv-completed-1";

// A finished transcript for the interview session: one marker-tagged question
// and the final fenced-JSON proposal, followed by the server's closing turn.
const PROPOSAL_JSON = [
  "```json",
  JSON.stringify({
    profile: { whatWeDo: "We run a dental clinic", teamShape: "About 12 people" },
    summary: "A family dental clinic that values clear scheduling.",
    facts: [
      { category: "Business", fact: "Runs a dental clinic", audience: "family" },
    ],
  }),
  "```",
].join("\n");

vi.mock("@/lib/hooks/useChat", () => ({
  useChat: () => ({
    messages: [
      { id: "u-1", role: "user", content: "We run a dental clinic." },
      { id: "a-1", role: "assistant", content: "[topic 3/7] How big is your team?" },
      { id: "u-2", role: "user", content: "About 12 people." },
      { id: "a-2", role: "assistant", content: PROPOSAL_JSON },
      { id: "a-3", role: "assistant", content: "Saved — edit any of this in Settings." },
    ],
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
    conversationId: INTERVIEW_CHAT_ID,
    loadConversation: vi.fn(),
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

// The profile fetch drives `interviewConversation` / `interviewActive`. Return
// a COMPLETED interview whose session id is the open conversation — the exact
// post-Apply state the bug regressed on. Everything else stays real so the
// child surfaces (history panel, session header) render as in production.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchBusinessProfile: vi.fn(async () => ({
      onboardingState: "completed",
      interviewChatId: INTERVIEW_CHAT_ID,
      workspaceType: "BUSINESS",
    })),
  };
});

import ChatPage from "@/app/chat/page";

describe("chat /chat — completed interview session shaping (WARP-1121)", () => {
  it("renders the ReviewCard for the stored proposal instead of raw fenced JSON", async () => {
    cleanup();
    render(<ChatPage />);

    // Waits for the profile fetch to resolve and the shaping to apply.
    const card = await screen.findByTestId("review-card");
    expect(card).toBeInTheDocument();

    // The raw proposal must NOT leak as visible text.
    expect(document.body.textContent).not.toContain("```json");
    expect(document.body.textContent).not.toContain('"whatWeDo"');
    expect(screen.queryByTestId("proposal-parse-failure")).toBeNull();
  });

  it("strips `[topic n/7]` markers from completed-session questions", async () => {
    cleanup();
    render(<ChatPage />);

    await screen.findByTestId("review-card");

    // The marker is gone; the question copy itself survives.
    expect(document.body.textContent).not.toContain("[topic 3/7]");
    expect(document.body.textContent).toContain("How big is your team?");
  });

  it("does NOT show the active-only progress chrome once completed", async () => {
    cleanup();
    render(<ChatPage />);

    await screen.findByTestId("review-card");

    // `interviewActive` is correctly false (state settled) — the progress
    // dots are active-only and must not appear, proving the shaping is
    // decoupled from the active flag rather than riding on it.
    expect(screen.queryByTestId("interview-progress")).toBeNull();
  });
});
