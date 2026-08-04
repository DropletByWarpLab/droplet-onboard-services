/**
 * WARP-1668 — the interview resume banner must never be a dead end.
 *
 * Bug (Romain, 2026-07-30): /chat showed "You were telling me about your
 * business — pick up where we left off?" but Resume did nothing — the page
 * would not load.
 *
 * Root cause: the banner's RENDER gate was strictly weaker than the condition
 * its click handler needs. Render asked only for the box-wide singleton state
 * (`onboardingState in {in_progress, re_running}`); the handler additionally
 * needs `interviewChatId` to be non-null AND to point at a ChatSession the
 * REQUESTING user owns (`getConversationForUser` is `where: {id, userId}`).
 * Neither was checked, and neither failure was handled:
 *
 *   - `interviewChatId` null  → `if (id) router.push(...)` silently no-ops.
 *     Reachable because the Prisma relation is `onDelete: SetNull`, which
 *     fires for ANY delete of the session row, while the compensating state
 *     reset lives only in the DELETE /llm/conversations/:id route handler.
 *   - session owned by another admin → push lands, the load 404s, the
 *     failure path strips `?c=` via `history.replaceState` (which does not
 *     notify `useSearchParams`), so nothing re-renders and the banner is
 *     still sitting there. Click, nothing, repeat.
 *
 * Fix: the server now reports `interviewResumable` (link present AND session
 * readable by this user) and the banner renders only when it is true — "if it
 * is not accessible, do not show it". When it IS true the click navigates as
 * before, and a load failure re-syncs the profile so the banner retires
 * instead of dead-ending.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

const INTERVIEW_CHAT_ID = "conv-interview-parked";

// Hoisted: vi.mock factories run before module-scope consts are initialised.
const { push, fetchBusinessProfile } = vi.hoisted(() => ({
  push: vi.fn(),
  fetchBusinessProfile: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(() => "/chat"),
  useRouter: vi.fn(() => ({ push, replace: vi.fn(), back: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

// An empty new-chat view — the surface the banner is designed to sit on.
vi.mock("@/lib/hooks/useChat", () => ({
  useChat: () => ({
    messages: [],
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
    conversationId: null,
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
  return { ...actual, fetchBusinessProfile };
});

import ChatPage from "@/app/chat/page";

describe("chat /chat — interview resume banner is never a dead end (WARP-1668)", () => {
  beforeEach(() => {
    push.mockClear();
    fetchBusinessProfile.mockReset();
  });
  afterEach(() => cleanup());

  it("does NOT show the banner when the parked interview is not resumable by this user", async () => {
    // in_progress box-wide, but the session link is gone — the exact shape
    // `onDelete: SetNull` leaves behind when the row is removed by any path
    // other than the DELETE route.
    fetchBusinessProfile.mockResolvedValue({
      onboardingState: "in_progress",
      interviewChatId: null,
      interviewResumable: false,
      workspaceType: "BUSINESS",
    });

    render(<ChatPage />);

    // The ordinary empty-chat hint proves the profile fetch resolved and the
    // page settled, so a missing banner is a real absence, not a slow render.
    await screen.findByText("Ask Droplet anything");
    expect(screen.queryByTestId("interview-resume-banner")).toBeNull();
  });

  it("does NOT show the banner when the interview session belongs to another admin", async () => {
    // Link present, but the session is not readable by this user — the server
    // resolves that and reports it, because the id alone cannot.
    fetchBusinessProfile.mockResolvedValue({
      onboardingState: "re_running",
      interviewChatId: "conv-owned-by-bob",
      interviewResumable: false,
      workspaceType: "BUSINESS",
    });

    render(<ChatPage />);

    await screen.findByText("Ask Droplet anything");
    expect(screen.queryByTestId("interview-resume-banner")).toBeNull();
  });

  it("shows the banner and navigates to the session when it IS resumable", async () => {
    fetchBusinessProfile.mockResolvedValue({
      onboardingState: "in_progress",
      interviewChatId: INTERVIEW_CHAT_ID,
      interviewResumable: true,
      workspaceType: "BUSINESS",
    });

    render(<ChatPage />);

    const banner = await screen.findByTestId("interview-resume-banner");
    expect(banner).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(
        `/chat?c=${encodeURIComponent(INTERVIEW_CHAT_ID)}`,
      ),
    );
  });

  it("treats a profile with no resumability field as not resumable", async () => {
    // An older orchestrator that predates the field must fail CLOSED: a
    // banner that cannot act is worse than no banner.
    fetchBusinessProfile.mockResolvedValue({
      onboardingState: "in_progress",
      interviewChatId: INTERVIEW_CHAT_ID,
      workspaceType: "BUSINESS",
    });

    render(<ChatPage />);

    await screen.findByText("Ask Droplet anything");
    expect(screen.queryByTestId("interview-resume-banner")).toBeNull();
  });
});
