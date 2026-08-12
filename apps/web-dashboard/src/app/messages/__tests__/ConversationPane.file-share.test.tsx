/**
 * WARP-1898 — the forwarded-file card.
 *
 * Reported symptom: "I had a file shared with me in a chat, I was not able
 * to open it — the folder linking was wrong too since it just took me to my
 * files." The card linked to `/files?path=<parent>` and nothing else, so:
 *
 *   - no `space` → /files applied the SENDER's space-relative path inside
 *     the RECIPIENT's personal space (its documented silent fallback), and
 *   - no `preview` → even a correct folder never opened the file.
 *
 * Forwarding grants nothing (routes/team-chat.ts stores a pointer and
 * re-checks nothing for the recipient), so this suite pins both halves: the
 * link is complete when the viewer can actually reach the space, and the
 * card refuses to link — with a reason — when they can't.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { TeamChatMessage, TeamChatThreadSummary } from "@/lib/api";
import type { FileSpacesResponse } from "@/lib/types";

const { fetchSpacesMock, useTeamChatMessagesMock } = vi.hoisted(() => ({
  fetchSpacesMock: vi.fn(),
  useTeamChatMessagesMock: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchSpaces: fetchSpacesMock,
  markTeamChatThreadRead: vi.fn(async () => {}),
  sendTeamChatMessage: vi.fn(),
}));

vi.mock("@/lib/hooks/useTeamChat", () => ({
  useTeamChatMessages: useTeamChatMessagesMock,
}));

// Assertions here are about the href this component HANDS to Link, so the
// anchor stands in for it directly (the idiom 25 other suites here use).
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ConversationPane } from "../ConversationPane";

const ME = "u-stefan";
const THEM = "u-sam";

/** Sam can reach Finance; the viewer's own set is what varies per test. */
const SPACES: FileSpacesResponse = {
  sharedAvailable: true,
  spaces: [
    { id: "personal", name: "My Files", root: "/" },
    { id: "shared", name: "Household", root: "/Household", kind: "household" },
    { id: "dept:finance", name: "Finance", root: "/Finance", kind: "department" },
  ],
};

function fileShare(over: Partial<TeamChatMessage> = {}): TeamChatMessage {
  return {
    id: "m1",
    threadId: "t1",
    senderId: THEM,
    senderDisplayName: "Sam R",
    kind: "file_share",
    body: null,
    sharedNcFileId: 4242,
    sharedFileName: "Q3 review.pdf",
    // HOME-relative, carrying the /Finance mount — the form a library
    // listing row actually has, and therefore what the picker stores.
    sharedFilePath: "/Finance/Reports/Q3 review.pdf",
    sharedFileSpace: "dept:finance",
    sharedChatSessionId: null,
    meetingId: null,
    meeting: null,
    createdAt: "2026-08-12T10:00:00.000Z",
    ...over,
  };
}

const THREAD: TeamChatThreadSummary = {
  id: "t1",
  kind: "direct",
  title: null,
  createdById: THEM,
  createdAt: "2026-08-12T09:00:00.000Z",
  lastMessageAt: "2026-08-12T10:00:00.000Z",
  participants: [
    { userId: ME, displayName: "Stefan C", username: "stefan" },
    { userId: THEM, displayName: "Sam R", username: "sam" },
  ],
  // Only the ThreadList preview reads this; the pane renders from the
  // messages hook, which each test drives directly.
  lastMessage: fileShare(),
  unreadCount: 0,
};

function renderPane(message: TeamChatMessage, spaces: FileSpacesResponse) {
  fetchSpacesMock.mockResolvedValue(spaces);
  useTeamChatMessagesMock.mockReturnValue({
    messages: [message],
    nextCursor: null,
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
  });
  return render(
    // Fresh cache per render: the "/api/files/spaces" key is constant, so a
    // shared provider would serve the previous test's space list.
    <SWRConfig value={{ provider: () => new Map() }}>
      <ConversationPane
        thread={THREAD}
        meId={ME}
        onBack={vi.fn()}
        onActivity={vi.fn()}
      />
    </SWRConfig>,
  );
}

beforeEach(() => {
  cleanup();
  fetchSpacesMock.mockReset();
  useTeamChatMessagesMock.mockReset();
});

describe("forwarded file card (WARP-1898)", () => {
  it("links with space + path + preview when the viewer can reach the space", async () => {
    renderPane(fileShare(), SPACES);

    const link = await screen.findByTestId("file-share-link");
    const href = link.getAttribute("href") ?? "";
    const qs = new URLSearchParams(href.split("?")[1] ?? "");

    // The space the SENDER's path is relative to — the param whose absence
    // dropped the recipient into their own files.
    expect(qs.get("space")).toBe("dept:finance");
    // SPACE-relative: the orchestrator re-prefixes the /Finance mount, so
    // the mounted form must NOT be sent (see the double-prefix test below).
    expect(qs.get("path")).toBe("/Reports");
    // HOME-relative: `preview` is matched against the loaded listing's own
    // entries, which carry the mount. Without it the old card landed on a
    // folder listing even when the folder was right.
    expect(qs.get("preview")).toBe("/Finance/Reports/Q3 review.pdf");
  });

  it("does not re-send the mount in ?path= (the WARP-1140 double-prefix)", async () => {
    renderPane(fileShare(), SPACES);
    const qs = new URLSearchParams(
      ((await screen.findByTestId("file-share-link")).getAttribute("href") ?? "")
        .split("?")[1] ?? "",
    );
    // "/Finance/Reports" would resolve server-side to "/Finance/Finance/
    // Reports" — a silently EMPTY folder, no error. Same class of failure as
    // the bug this ticket fixes, so it gets its own guard.
    expect(qs.get("path")).not.toBe("/Finance/Reports");
    expect(qs.get("path")?.startsWith("/Finance")).toBe(false);
  });

  it("refuses to link a space the viewer cannot reach, and says why", async () => {
    const noFinance: FileSpacesResponse = {
      sharedAvailable: true,
      spaces: SPACES.spaces.filter((s) => s.id !== "dept:finance"),
    };
    renderPane(fileShare(), noFinance);

    expect(await screen.findByTestId("file-share-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("file-share-link")).toBeNull();
    expect(
      screen.getByText("You don't have access to where this file is kept."),
    ).toBeTruthy();
  });

  it("names the sender when the file is in THEIR personal space (no grant exists)", async () => {
    renderPane(fileShare({ sharedFileSpace: "personal" }), SPACES);

    expect(await screen.findByTestId("file-share-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("file-share-link")).toBeNull();
    expect(
      screen.getByText("Only Sam R can open this — it's in their personal files."),
    ).toBeTruthy();
  });

  it("still links MY OWN personal-space file — I can open that one", async () => {
    renderPane(
      fileShare({
        senderId: ME,
        senderDisplayName: "Stefan C",
        sharedFileSpace: "personal",
        // Personal rows carry no mount; their root is "/".
        sharedFilePath: "/Reports/Q3 review.pdf",
      }),
      SPACES,
    );

    const link = await screen.findByTestId("file-share-link");
    const qs = new URLSearchParams((link.getAttribute("href") ?? "").split("?")[1] ?? "");
    // buildFilesUrl omits `space` for personal — matching every other Files
    // link, and /files defaults an absent space to personal anyway.
    expect(qs.get("space")).toBeNull();
    expect(qs.get("path")).toBe("/Reports");
    expect(qs.get("preview")).toBe("/Reports/Q3 review.pdf");
  });

  it("does not guess 'personal' for a pre-WARP-1898 row with no recorded space", async () => {
    renderPane(fileShare({ sharedFileSpace: null }), SPACES);

    expect(await screen.findByTestId("file-share-unavailable")).toBeTruthy();
    // The whole defect was resolving an unknown space AS personal. A link of
    // any kind here would repeat it.
    expect(screen.queryByTestId("file-share-link")).toBeNull();
    expect(
      screen.getByText(
        "Droplet can't tell where this file is kept — ask for it again.",
      ),
    ).toBeTruthy();
  });
});
