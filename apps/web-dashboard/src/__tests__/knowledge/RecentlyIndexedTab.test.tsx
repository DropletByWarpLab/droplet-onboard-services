import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: any) => {
    const React = require("react");
    return React.createElement("a", props, children);
  },
}));

const getRecentFilesMock = vi.fn();
vi.mock("@/lib/api", () => ({
  getRecentFiles: (...args: any[]) => getRecentFilesMock(...args),
}));

import { RecentlyIndexedTab } from "@/app/knowledge/RecentlyIndexedTab";

describe("RecentlyIndexedTab", () => {
  beforeEach(() => {
    cleanup();
    getRecentFilesMock.mockReset();
  });

  it("shows the persona-on-tone empty state when nothing is indexed", async () => {
    getRecentFilesMock.mockResolvedValue({ items: [], nextBefore: null });
    render(<RecentlyIndexedTab />);
    const empty = await screen.findByTestId("knowledge-empty");
    expect(empty.textContent).toMatch(/No files indexed yet/);
    expect(empty.textContent).toMatch(/Drop a file in chat/);
    // Link to /files for users who prefer the Nextcloud upload route
    const link = empty.querySelector('a[href="/files"]');
    expect(link).toBeTruthy();
  });

  it("renders day-grouped cards when items are returned", async () => {
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86_400_000);
    getRecentFilesMock.mockResolvedValue({
      items: [
        {
          id: "1",
          ncFileId: 1,
          path: "/Documents/notes.txt",
          chunkIdx: 0,
          snippet: "Hello world",
          indexedAt: today.toISOString(),
          source: "nextcloud",
          brainItemId: null,
          pageNumber: null,
        },
        {
          id: "2",
          ncFileId: 2,
          path: "/Brain/abstract.md",
          chunkIdx: 0,
          snippet: "Brain stuff",
          indexedAt: yesterday.toISOString(),
          source: "brain",
          brainItemId: "x",
          pageNumber: null,
        },
      ],
      nextBefore: null,
    });

    render(<RecentlyIndexedTab />);
    const items = await screen.findAllByTestId("knowledge-recent-item");
    expect(items).toHaveLength(2);
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
    // Source badges
    expect(screen.getByText("Brain")).toBeInTheDocument();
    expect(screen.getByText("Nextcloud")).toBeInTheDocument();
  });

  it("forwards ?source filter to the api", async () => {
    getRecentFilesMock.mockResolvedValue({ items: [], nextBefore: null });
    render(<RecentlyIndexedTab source="brain" />);
    await waitFor(() => {
      expect(getRecentFilesMock).toHaveBeenCalled();
    });
    expect(getRecentFilesMock.mock.calls[0][0]).toMatchObject({ source: "brain" });
  });

  it("renders a friendly error card when the api throws — never echoes err.message (WARP-294)", async () => {
    const SECRET = "boom-internal-error-503";
    getRecentFilesMock.mockRejectedValue(new Error(SECRET));
    render(<RecentlyIndexedTab />);
    const alert = await screen.findByRole("alert");
    // Friendly knowledge-domain fallback — non-empty, no SECRET.
    expect(alert.textContent).toBeTruthy();
    expect(alert.textContent).not.toMatch(new RegExp(SECRET));
    expect(alert.textContent).not.toMatch(/503/);
  });

  it("never renders internal Nextcloud path prefixes (WARP-294)", async () => {
    getRecentFilesMock.mockResolvedValue({
      items: [
        {
          id: "1",
          ncFileId: 1,
          path: "/admin/files/private/Knowledge/notes.md",
          chunkIdx: 0,
          snippet: "x",
          indexedAt: new Date().toISOString(),
          source: "nextcloud",
          brainItemId: null,
          pageNumber: null,
        },
      ],
      nextBefore: null,
    });
    render(<RecentlyIndexedTab />);
    const items = await screen.findAllByTestId("knowledge-recent-item");
    const text = items[0].textContent ?? "";
    expect(text).not.toMatch(/admin\/files/);
    expect(text).not.toMatch(/^\/private/);
    // Trimmed display path still gives the user file context.
    expect(text).toMatch(/Knowledge\/notes\.md|notes\.md/);
  });

  it("shows a Load more button when nextBefore is present", async () => {
    getRecentFilesMock.mockResolvedValue({
      items: [
        {
          id: "1",
          ncFileId: 1,
          path: "/a.txt",
          chunkIdx: 0,
          snippet: "x",
          indexedAt: new Date().toISOString(),
          source: "nextcloud",
          brainItemId: null,
          pageNumber: null,
        },
      ],
      nextBefore: "2026-04-01T00:00:00.000Z",
    });
    render(<RecentlyIndexedTab />);
    const btn = await screen.findByRole("button", { name: /load more/i });
    expect(btn).toBeInTheDocument();
  });
});
