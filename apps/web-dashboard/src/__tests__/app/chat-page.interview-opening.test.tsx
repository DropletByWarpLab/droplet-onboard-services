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
 *
 * WARP-2667 follow-up (pr-reviewer, #1987) — the first cut of half 2 keyed the
 * suppression off `interviewConversation`, which is `conversationId ===
 * bizProfile.interviewChatId`. Both sides of that comparison move on their own
 * clock: `onboardingState` leaves `not_started` the moment the profile refresh
 * lands, while `conversationId` only catches up when the URL-driven
 * `loadConversation` round trip resolves. In between, the intro-card branch is
 * already false and the interview branch is not yet true — and the generic
 * empty state paints inside the session the click just created, which is the
 * very bug this file exists to prevent. The three tests above cannot see it:
 * they hand `useChat` a `conversationId` that already equals the interview id
 * on first render, so the transition never happens. The two below hold the
 * page IN that window.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

const INTERVIEW_CHAT_ID = "conv-interview-fresh";

// The server-authored opener, verbatim as the orchestrator seeds it. Kept as
// a literal (not imported from the backend package) so a copy change on
// either side is a visible diff on both.
const OPENING_TURN =
  "[topic 1/7] To start — in a sentence or two, what does your business do?";

const { state, push, fetchBusinessProfile, startBusinessOnboarding } = vi.hoisted(
  () => {
    const state = {
      messages: [] as Array<{ id: string; role: string; content: string }>,
      // `useChat`'s id. Settable to null on purpose: that is the value it
      // actually holds for the whole `loadConversation` round trip after a
      // `router.push`, and the window the fix has to survive.
      conversationId: null as string | null,
      // The live `?c=` bag. `router.push` rewrites it, exactly as the real
      // router does — a static mock would make the transition untestable.
      params: new URLSearchParams(),
      profile: {} as Record<string, unknown>,
    };
    return {
      state,
      push: vi.fn((url: string) => {
        state.params = new URLSearchParams(url.split("?")[1] ?? "");
      }),
      fetchBusinessProfile: vi.fn(async () => state.profile),
      startBusinessOnboarding: vi.fn(),
    };
  },
);

vi.mock("next/navigation", () => ({
  usePathname: () => "/chat",
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => state.params,
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
    // Whatever the test parks it at: the interview id (the settled frame,
    // one navigation after Start) or null (the in-flight frame).
    conversationId: state.conversationId,
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
  return { ...actual, fetchBusinessProfile, startBusinessOnboarding };
});

const IN_PROGRESS = {
  onboardingState: "in_progress",
  interviewChatId: INTERVIEW_CHAT_ID,
  interviewResumable: true,
  workspaceType: "BUSINESS",
} as const;

import ChatPage from "@/app/chat/page";

describe("chat /chat — a started interview opens with its first question", () => {
  beforeEach(() => {
    state.messages = [];
    // The settled frame the first three tests were written against, kept
    // byte-for-byte: interview session loaded, no `?c=` in the bag.
    state.conversationId = INTERVIEW_CHAT_ID;
    state.params = new URLSearchParams();
    state.profile = { ...IN_PROGRESS };
    push.mockClear();
    fetchBusinessProfile.mockClear();
    startBusinessOnboarding.mockReset();
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

  // ── the transition, not the settled frame ────────────────────────────────
  // Everything above renders a page whose `conversationId` is ALREADY the
  // interview id. These two hold it at null — which is what it is for the
  // whole `loadConversation` round trip that follows `router.push` — and
  // assert that no frame in that window belongs to the generic empty state.

  it("never falls back to the generic empty state between the Start click and the session loading", async () => {
    // Before the click: an untouched BUSINESS box on a plain /chat.
    state.conversationId = null;
    state.params = new URLSearchParams();
    state.profile = {
      onboardingState: "not_started",
      interviewChatId: null,
      interviewResumable: false,
      workspaceType: "BUSINESS",
    };
    // The server moves during the call — session created, profile pointed at
    // it — exactly as `startOnboarding` does in one transaction.
    startBusinessOnboarding.mockImplementation(async () => {
      state.profile = { ...IN_PROGRESS };
      return {
        conversationId: INTERVIEW_CHAT_ID,
        state: "in_progress",
        created: true,
      };
    });

    const { rerender } = render(<ChatPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Start" }));

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(
        `/chat?c=${encodeURIComponent(INTERVIEW_CHAT_ID)}`,
      ),
    );
    // Next re-renders the tree off its own router state on a push; the mock
    // has no way to, so drive the frame the push produces. `conversationId`
    // deliberately stays null — this IS the window.
    rerender(<ChatPage />);

    // The intro card has retired (the profile is off `not_started`)…
    expect(screen.queryByTestId("interview-intro-card")).toBeNull();
    // …and what replaced it is the interview, NOT "Ask Droplet anything"
    // plus four prompts about dimming the living-room lights.
    expect(screen.queryByText("Ask Droplet anything")).toBeNull();
  });

  it("never falls back to the generic empty state between Resume and the session loading", async () => {
    // `handleResumeOpen` pushes with no await at all, so the same window
    // opens on the parked-interview path.
    state.conversationId = null;
    state.params = new URLSearchParams();
    state.profile = { ...IN_PROGRESS };

    const { rerender } = render(<ChatPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    expect(push).toHaveBeenCalledWith(
      `/chat?c=${encodeURIComponent(INTERVIEW_CHAT_ID)}`,
    );
    rerender(<ChatPage />);

    // The banner does not sit inside the session it just opened…
    expect(screen.queryByTestId("interview-resume-banner")).toBeNull();
    // …and neither does the generic empty state.
    expect(screen.queryByText("Ask Droplet anything")).toBeNull();
  });
});
