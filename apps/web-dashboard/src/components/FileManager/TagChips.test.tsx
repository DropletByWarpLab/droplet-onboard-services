/**
 * WARP-881 / WS-3 — TagChips: file-scoped tag chips in the Files detail panel.
 *
 * Covers: empty state, optimistic add, remove, duplicate no-op, guest gating.
 * The api layer is mocked so the suite drives the optimistic-mutation hook
 * through real render/interaction (no fixtures, no network).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { FileTagInfo } from "@/lib/types";

const useAuthMock = vi.fn();
vi.mock("@/lib/auth", () => ({ useAuth: () => useAuthMock() }));

vi.mock("@/lib/api", () => ({
  fetchFileTags: vi.fn(),
  addFileTag: vi.fn(),
  deleteFileTag: vi.fn(),
}));

import { fetchFileTags, addFileTag, deleteFileTag } from "@/lib/api";
import { TagChips } from "./TagChips";

function tag(label: string, over: Partial<FileTagInfo> = {}): FileTagInfo {
  return {
    id: `id-${label}`,
    ncFileId: 1,
    label,
    addedByUserId: "user-a",
    createdAt: new Date().toISOString(),
    ...over,
  };
}

// Fresh SWR cache per render so one test's data never leaks into another.
function renderPanel(filePath = "/Documents/report.pdf") {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <TagChips filePath={filePath} />
    </SWRConfig>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthMock.mockReturnValue({ user: { id: "user-a", role: "family" } });
  (fetchFileTags as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (addFileTag as ReturnType<typeof vi.fn>).mockImplementation(
    async (_p: string, label: string) => tag(label, { id: `srv-${label}` }),
  );
  (deleteFileTag as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
});

describe("WARP-881 — TagChips", () => {
  it("renders the empty state when a file has no tags", async () => {
    renderPanel();
    expect(await screen.findByText(/no tags yet/i)).toBeInTheDocument();
  });

  it("optimistically adds a tag and persists it", async () => {
    renderPanel();
    await screen.findByText(/no tags yet/i);

    const input = screen.getByPlaceholderText(/add a tag/i);
    fireEvent.change(input, { target: { value: "invoice" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // The chip is present after the add — re-query each poll (the optimistic
    // node is detached + replaced by the server row, both reading "invoice",
    // so a stale findByText reference can race the swap).
    await waitFor(() => expect(screen.getByText("invoice")).toBeInTheDocument());
    await waitFor(() =>
      expect(addFileTag).toHaveBeenCalledWith("/Documents/report.pdf", "invoice"),
    );
  });

  it("removes a tag when its x is clicked", async () => {
    (fetchFileTags as ReturnType<typeof vi.fn>).mockResolvedValue([tag("draft")]);
    renderPanel();
    expect(await screen.findByText("draft")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/remove tag draft/i));
    await waitFor(() =>
      expect(deleteFileTag).toHaveBeenCalledWith("/Documents/report.pdf", "draft"),
    );
    await waitFor(() => expect(screen.queryByText("draft")).not.toBeInTheDocument());
  });

  it("duplicate label is a no-op — no second add call", async () => {
    (fetchFileTags as ReturnType<typeof vi.fn>).mockResolvedValue([tag("tax")]);
    renderPanel();
    expect(await screen.findByText("tax")).toBeInTheDocument();

    const input = screen.getByPlaceholderText(/add a tag/i);
    fireEvent.change(input, { target: { value: "tax" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Short-circuited client-side: addFileTag must NOT fire for a dupe.
    await waitFor(() => expect(addFileTag).not.toHaveBeenCalled());
    // Still exactly one chip.
    expect(screen.getAllByText("tax")).toHaveLength(1);
  });

  it("shows a read-only note for guests and never fetches", async () => {
    useAuthMock.mockReturnValue({ user: { id: "g", role: "guest" } });
    renderPanel();
    expect(await screen.findByText(/aren't available for guests/i)).toBeInTheDocument();
    expect(fetchFileTags).not.toHaveBeenCalled();
  });
});
