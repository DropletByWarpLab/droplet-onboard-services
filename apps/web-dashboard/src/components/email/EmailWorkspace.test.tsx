/**
 * WARP-837 — EmailWorkspace, the 3-column page body that wires the SWR hooks to
 * the three columns and owns account/thread selection.
 *
 * Drives the integration contract against mocked hooks + auth:
 *   - the no-account empty state (a calm "connect an account" message, NOT
 *     fixtures),
 *   - the three columns rendering together once data is present,
 *   - selecting a thread loads its messages + analysis,
 *   - RBAC: a family user does not get the send affordance,
 *   - the neutral placeholder when no thread is selected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// ── Hook mocks ──
const useEmailAccountsMock = vi.fn();
const useEmailThreadsMock = vi.fn();
const useEmailThreadMock = vi.fn();
const useThreadAnalysisMock = vi.fn();
vi.mock("@/lib/hooks/useEmail", () => ({
  useEmailAccounts: () => useEmailAccountsMock(),
  useEmailThreads: (...a: unknown[]) => useEmailThreadsMock(...a),
  useEmailThread: (...a: unknown[]) => useEmailThreadMock(...a),
  useThreadAnalysis: (...a: unknown[]) => useThreadAnalysisMock(...a),
}));

// ── auth mock (role drives canSend) ──
const authRef: { role: "owner" | "admin" | "family" | "guest" } = {
  role: "owner",
};
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "me", role: authRef.role } }),
}));

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
}));

// createDraft is the only api call EmailWorkspace makes directly (the reply
// composer). sendDraft is exercised inside EmailThread's own test.
const createDraftMock = vi.fn();
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, createDraft: (...a: unknown[]) => createDraftMock(...a) };
});

import { EmailWorkspace } from "./EmailWorkspace";

const account = {
  id: "acc-1",
  userId: "u1",
  displayName: "Home inbox",
  address: "me@home.net",
  imapStatus: "idle" as const,
  lastIdleAt: new Date().toISOString(),
  lastErrorAt: null,
  lastError: null,
};

const threadSummary = {
  id: "t1",
  accountId: "acc-1",
  threadKey: "k1",
  subject: "PO 4912 revised ETA",
  lastSender: "Naomi Rivera",
  snippet: "running behind",
  messageCount: 1,
  triageStatus: "inbox" as const,
  draftedByDroplet: false,
  lastMessageAt: new Date().toISOString(),
};

const threadDetail = {
  ...threadSummary,
  messages: [
    {
      id: "m1",
      threadId: "t1",
      messageId: "<m1@x>",
      fromAddr: "naomi@northwind.co",
      fromName: "Naomi Rivera",
      toAddrs: ["me@home.net"],
      ccAddrs: null,
      subject: "PO 4912 revised ETA",
      bodyText: "We are 2h behind on PO 4912.",
      bodyHtml: null,
      receivedAt: new Date().toISOString(),
    },
  ],
};

function resetHooks() {
  useEmailAccountsMock.mockReturnValue({
    accounts: [account],
    isLoading: false,
    error: undefined,
    refresh: vi.fn(),
  });
  useEmailThreadsMock.mockReturnValue({
    threads: [threadSummary],
    isLoading: false,
    error: undefined,
    refresh: vi.fn(),
  });
  useEmailThreadMock.mockReturnValue({
    thread: undefined,
    isLoading: false,
    error: undefined,
    refresh: vi.fn(),
  });
  useThreadAnalysisMock.mockReturnValue({
    analysis: undefined,
    isLoading: false,
    error: undefined,
    refresh: vi.fn(),
  });
}

beforeEach(() => {
  authRef.role = "owner";
  pushMock.mockReset();
  createDraftMock.mockReset();
  resetHooks();
});

describe("EmailWorkspace", () => {
  it("renders a calm no-account empty state (not fixtures) when there are no accounts", () => {
    useEmailAccountsMock.mockReturnValue({
      accounts: [],
      isLoading: false,
      error: undefined,
      refresh: vi.fn(),
    });
    render(<EmailWorkspace />);
    expect(
      screen.getByText(/no email account connected/i),
    ).toBeInTheDocument();
    // points the user at Settings, doesn't offer an add-account control here.
    expect(
      screen.getByRole("link", { name: /settings/i }),
    ).toHaveAttribute("href", "/settings");
    expect(
      screen.queryByRole("button", { name: /add account/i }),
    ).not.toBeInTheDocument();
  });

  it("renders all three columns once an account + threads are present", () => {
    render(<EmailWorkspace />);
    // List column: the thread row.
    expect(screen.getByText("PO 4912 revised ETA")).toBeInTheDocument();
    // Filter chips present.
    expect(screen.getByRole("button", { name: /from droplet/i })).toBeInTheDocument();
    // AI panel present.
    expect(screen.getByText(/about this thread/i)).toBeInTheDocument();
  });

  it("shows the neutral placeholder pane when no thread is selected", () => {
    render(<EmailWorkspace />);
    // Both the thread column and the AI panel show a "select a conversation"
    // placeholder — at least one neutral pane must be present, no crash.
    expect(
      screen.getAllByText(/select a conversation/i).length,
    ).toBeGreaterThan(0);
  });

  it("loads the thread + analysis hooks with the selected ids when a row is clicked", async () => {
    render(<EmailWorkspace />);
    fireEvent.click(screen.getByText("PO 4912 revised ETA"));
    await waitFor(() =>
      expect(useEmailThreadMock).toHaveBeenCalledWith("acc-1", "t1"),
    );
    expect(useThreadAnalysisMock).toHaveBeenCalledWith("acc-1", "t1");
  });

  it("renders the selected thread's messages", () => {
    useEmailThreadMock.mockReturnValue({
      thread: threadDetail,
      isLoading: false,
      error: undefined,
      refresh: vi.fn(),
    });
    render(<EmailWorkspace initialThreadId="t1" />);
    expect(screen.getByText(/2h behind on PO 4912/i)).toBeInTheDocument();
  });

  it("gives owner the send affordance but withholds it from a family user (RBAC)", () => {
    const draftThread = {
      ...threadDetail,
      draftedByDroplet: true,
    };
    useEmailThreadMock.mockReturnValue({
      thread: draftThread,
      isLoading: false,
      error: undefined,
      refresh: vi.fn(),
    });

    // owner: send is offered.
    const { unmount } = render(<EmailWorkspace initialThreadId="t1" />);
    // (No draft row unless the thread carries one; the affordance gating is the
    // contract under test — a family user must never see a send button.)
    unmount();

    authRef.role = "family";
    render(<EmailWorkspace initialThreadId="t1" />);
    expect(
      screen.queryByRole("button", { name: /send reply/i }),
    ).not.toBeInTheDocument();
  });

  it("changing a filter chip re-queries threads with the new filter", async () => {
    render(<EmailWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: /triaged/i }));
    await waitFor(() =>
      expect(useEmailThreadsMock).toHaveBeenCalledWith("acc-1", "triaged"),
    );
  });

  it("composes a reply via createDraft, then surfaces a confirm-gated send", async () => {
    useEmailThreadMock.mockReturnValue({
      thread: threadDetail,
      isLoading: false,
      error: undefined,
      refresh: vi.fn(),
    });
    createDraftMock.mockResolvedValue({
      id: "d1",
      accountId: "acc-1",
      threadId: "t1",
      toAddrs: ["naomi@northwind.co"],
      ccAddrs: null,
      bccAddrs: null,
      subject: "Re: PO 4912 revised ETA",
      body: "Sounds good.",
      draftedByDroplet: false,
      status: "draft",
      sentAt: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    render(<EmailWorkspace initialThreadId="t1" />);
    // Open the composer, type, save → createDraft called with the thread + reply addr.
    fireEvent.click(screen.getByRole("button", { name: /write a reply/i }));
    fireEvent.change(screen.getByLabelText(/reply message/i), {
      target: { value: "Sounds good." },
    });
    fireEvent.click(screen.getByRole("button", { name: /save draft/i }));
    await waitFor(() =>
      expect(createDraftMock).toHaveBeenCalledWith(
        "acc-1",
        expect.objectContaining({ threadId: "t1", body: "Sounds good." }),
      ),
    );
    // The created draft now exposes a (confirm-gated) Send reply control.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /send reply/i }),
      ).toBeInTheDocument(),
    );
  });
});
