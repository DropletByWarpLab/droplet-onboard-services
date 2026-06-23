/**
 * WARP-881 / WS-3 — CommentsPanel: file comments in the Files detail panel.
 *
 * Covers: empty state, optimistic add, own-vs-others delete visibility
 * (mirrors the server author-or-privileged guard), guest gating. The api
 * layer is mocked so the suite drives the optimistic-mutation hook through
 * real render/interaction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { FileCommentInfo } from "@/lib/types";

const useAuthMock = vi.fn();
vi.mock("@/lib/auth", () => ({ useAuth: () => useAuthMock() }));

vi.mock("@/lib/api", () => ({
  fetchFileComments: vi.fn(),
  addFileComment: vi.fn(),
  deleteFileComment: vi.fn(),
}));

import {
  fetchFileComments,
  addFileComment,
  deleteFileComment,
} from "@/lib/api";
import { CommentsPanel } from "./CommentsPanel";

function comment(
  body: string,
  authorUserId: string,
  over: Partial<FileCommentInfo> = {},
): FileCommentInfo {
  const now = new Date().toISOString();
  return {
    id: `id-${body}`,
    ncFileId: 1,
    authorUserId,
    body,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function renderPanel(filePath = "/Documents/report.pdf") {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <CommentsPanel filePath={filePath} />
    </SWRConfig>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthMock.mockReturnValue({ user: { id: "user-a", role: "family" } });
  (fetchFileComments as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (addFileComment as ReturnType<typeof vi.fn>).mockImplementation(
    async (_p: string, body: string) =>
      comment(body, "user-a", { id: "srv-1" }),
  );
  (deleteFileComment as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
});

describe("WARP-881 — CommentsPanel", () => {
  it("renders the empty state when a file has no comments", async () => {
    renderPanel();
    expect(await screen.findByText(/no comments yet/i)).toBeInTheDocument();
  });

  it("optimistically adds a comment and persists it", async () => {
    renderPanel();
    await screen.findByText(/no comments yet/i);

    const input = screen.getByPlaceholderText(/add a comment/i);
    fireEvent.change(input, { target: { value: "Looks good" } });
    fireEvent.click(screen.getByRole("button", { name: /post/i }));

    // Re-query each poll: the optimistic node is detached + replaced by the
    // server row (both read "Looks good"), so a stale findByText reference
    // can race the swap.
    await waitFor(() =>
      expect(screen.getByText("Looks good")).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(addFileComment).toHaveBeenCalledWith(
        "/Documents/report.pdf",
        "Looks good",
      ),
    );
  });

  it("shows a delete control for the viewer's own comment (family)", async () => {
    (fetchFileComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      comment("mine", "user-a"),
    ]);
    renderPanel();
    expect(await screen.findByText("mine")).toBeInTheDocument();
    expect(screen.getByLabelText(/delete comment/i)).toBeInTheDocument();
  });

  it("hides the delete control on another user's comment (family)", async () => {
    (fetchFileComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      comment("theirs", "user-b"),
    ]);
    renderPanel();
    expect(await screen.findByText("theirs")).toBeInTheDocument();
    expect(screen.queryByLabelText(/delete comment/i)).not.toBeInTheDocument();
  });

  it("owner sees a delete control even on another user's comment", async () => {
    useAuthMock.mockReturnValue({ user: { id: "owner-1", role: "owner" } });
    (fetchFileComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      comment("anyone's", "user-b"),
    ]);
    renderPanel();
    expect(await screen.findByText("anyone's")).toBeInTheDocument();
    expect(screen.getByLabelText(/delete comment/i)).toBeInTheDocument();
  });

  it("deletes a comment optimistically", async () => {
    (fetchFileComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      comment("to delete", "user-a", { id: "cmt-x" }),
    ]);
    renderPanel();
    expect(await screen.findByText("to delete")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/delete comment/i));
    await waitFor(() => expect(deleteFileComment).toHaveBeenCalledWith("cmt-x"));
    await waitFor(() =>
      expect(screen.queryByText("to delete")).not.toBeInTheDocument(),
    );
  });

  it("shows a read-only note for guests and never fetches", async () => {
    useAuthMock.mockReturnValue({ user: { id: "g", role: "guest" } });
    renderPanel();
    expect(
      await screen.findByText(/aren't available for guests/i),
    ).toBeInTheDocument();
    expect(fetchFileComments).not.toHaveBeenCalled();
  });
});
