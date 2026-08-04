/**
 * WARP-1682 — a failed delete must still re-list the directory.
 *
 * Reported symptom: "when trying to delete a file I get an error and the file
 * is either still there or disappears after a page reload". The second half is
 * this file's subject. `performDelete` only reached `refresh()` on the success
 * path, so ANY error — including the spurious 404 the orchestrator used to
 * return for an already-absent path — left the deleted row sitting on screen
 * until the user reloaded the page.
 *
 * Refreshing on the error path is what makes the UI self-correcting: whatever
 * the server actually did, the next listing is the truth. It also costs
 * nothing when the delete genuinely failed — the row simply re-renders.
 *
 * Mock stack modeled on files-page.multiselect.test.tsx; `useFiles.refresh` is
 * the observable under test, so it is a stable spy rather than a per-render
 * `vi.fn()`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { FileEntryInfo } from "@/lib/types";

const DOOMED: FileEntryInfo = {
  name: "doomed.txt",
  path: "/doomed.txt",
  size: 4,
  isDirectory: false,
  mimeType: "text/plain",
  modifiedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
} as unknown as FileEntryInfo;

const refreshSpy = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/hooks/useFiles", () => ({
  useFiles: () => ({ files: [DOOMED], error: null, isLoading: false, refresh: refreshSpy }),
}));

vi.mock("@/lib/hooks/useFavorites", () => ({
  useFavorites: () => ({ items: [], refresh: vi.fn() }),
}));

vi.mock("@/lib/hooks/useFileRealtime", () => ({
  useFileRealtime: vi.fn(),
}));

vi.mock("@/lib/hooks/useSpaces", () => ({
  useSpaces: () => ({ spaces: [], sharedAvailable: false }),
}));

vi.mock("@/lib/hooks/useDevice", () => ({
  useDevice: () => ({
    device: { hostname: "droplet" },
    devices: [],
    health: undefined,
    isLoading: false,
    error: null,
  }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    uploadFiles: vi.fn(),
    deleteFile: vi.fn(),
    createDirectory: vi.fn(),
    getDownloadUrl: (p: string) => `/api/files/download?path=${p}`,
    getThumbnailUrl: (p: string) => `/api/files/thumbnail?path=${p}`,
    renameFile: vi.fn(),
    bulkDeleteFiles: vi.fn(),
    bulkMoveFiles: vi.fn(),
    bulkCopyFiles: vi.fn(),
    fetchShares: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    authFetch: vi.fn().mockResolvedValue({ text: () => Promise.resolve("") }),
    useAuth: () => ({
      user: { id: "u1", username: "owner", displayName: "Owner", role: "owner" },
      isLoading: false,
    }),
  };
});

import FilesPage from "@/app/files/page";
import { deleteFile, bulkDeleteFiles } from "@/lib/api";

/** Row action → <ConfirmDialog> → confirm. */
async function deleteDoomedFile() {
  fireEvent.click(screen.getByRole("button", { name: /delete doomed\.txt/i }));
  const confirm = await screen.findByRole("button", { name: /^delete$/i });
  fireEvent.click(confirm);
}

describe("Files page — a failed delete still re-lists the directory (WARP-1682)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it("refreshes the listing when deleteFile rejects", async () => {
    vi.mocked(deleteFile).mockRejectedValueOnce(new Error("Failed to delete: 500"));
    render(<FilesPage />);

    await deleteDoomedFile();

    await waitFor(() => expect(deleteFile).toHaveBeenCalledTimes(1));
    // Pre-fix: refresh() was unreachable from the catch block, so the deleted
    // row stayed on screen until a manual page reload.
    await waitFor(() => expect(refreshSpy).toHaveBeenCalled());
  });

  it("still refreshes on the success path", async () => {
    vi.mocked(deleteFile).mockResolvedValueOnce(undefined);
    render(<FilesPage />);

    await deleteDoomedFile();

    await waitFor(() => expect(refreshSpy).toHaveBeenCalled());
  });

  it("refreshes the listing when bulkDeleteFiles rejects", async () => {
    vi.mocked(bulkDeleteFiles).mockRejectedValueOnce(new Error("Bulk delete failed: 500"));
    render(<FilesPage />);

    // Select the row, then use the selection toolbar's "Trash" action.
    fireEvent.click(screen.getByRole("checkbox", { name: /select doomed\.txt/i }));
    fireEvent.click(screen.getByRole("button", { name: /^trash$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /move to trash/i }));

    await waitFor(() => expect(bulkDeleteFiles).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refreshSpy).toHaveBeenCalled());
  });
});
