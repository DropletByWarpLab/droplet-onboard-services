/**
 * WARP-1683 (UX review pins) — ThreadList behavior that review flagged and
 * this suite keeps closed:
 *
 *   1. a failed FIRST load renders the honest "retrying" line, never a
 *      silent blank pane (finding #1);
 *   2. the unread pill's numeral is aria-hidden with adjacent sr-only text —
 *      an aria-label on a generic <span> is ignored by screen readers
 *      (finding #3; same pattern pinned for the nav badge in
 *      Sidebar.nav-badge.test.tsx).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThreadList } from "../ThreadList";
import type { TeamChatThreadSummary } from "@/lib/api";

function thread(over: Partial<TeamChatThreadSummary> = {}): TeamChatThreadSummary {
  return {
    id: "t1",
    kind: "direct",
    title: null,
    createdById: "u-alice",
    createdAt: "2026-08-01T10:00:00.000Z",
    lastMessageAt: "2026-08-01T10:00:00.000Z",
    participants: [
      { userId: "u-alice", displayName: "Alice A", username: "alice" },
      { userId: "u-bob", displayName: "Bob B", username: "bob" },
    ],
    lastMessage: {
      id: "m1",
      threadId: "t1",
      senderId: "u-bob",
      senderDisplayName: "Bob B",
      kind: "text",
      body: "ping",
      sharedNcFileId: null,
      sharedFileName: null,
      sharedFilePath: null,
      sharedChatSessionId: null,
      createdAt: "2026-08-01T10:00:00.000Z",
    },
    unreadCount: 0,
    ...over,
  };
}

const noop = vi.fn();

describe("ThreadList — UX review pins (WARP-1683)", () => {
  it("renders the retrying line when the first load failed (no silent blank pane)", () => {
    render(
      <ThreadList
        threads={undefined}
        isLoading={false}
        loadFailed
        meId="u-alice"
        selectedThreadId={null}
        onSelect={noop}
        onCompose={noop}
      />,
    );
    expect(
      screen.getByText("Couldn't load conversations — retrying."),
    ).toBeTruthy();
  });

  it("unread pill: numeral aria-hidden, meaning carried by sr-only text", () => {
    render(
      <ThreadList
        threads={[thread({ unreadCount: 3 })]}
        isLoading={false}
        meId="u-alice"
        selectedThreadId={null}
        onSelect={noop}
        onCompose={noop}
      />,
    );
    const numeral = screen.getByText("3");
    expect(numeral.getAttribute("aria-hidden")).toBe("true");
    const srText = screen.getByText("3 unread");
    expect(srText.className).toContain("sr-only");
  });
});
