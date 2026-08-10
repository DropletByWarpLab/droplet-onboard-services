/**
 * WARP-1843 — the partial-upload toast must tell the continue-past truth.
 *
 * WARP-1666 made a failed batch surface "Uploaded N of M files" instead of
 * pretending the whole selection was lost. WARP-1843 goes further: a failed
 * batch no longer aborts the run, so the files that didn't land can be a
 * non-contiguous slice of the selection — "the rest" stopped being accurate.
 * The toast now says exactly how many didn't upload, with every count
 * composed from the typed `UploadBatchError` (never from the raw server
 * message — `translateError`'s no-echo posture, unchanged).
 *
 * Mock stack modeled on files-page.delete-error-refresh.test.tsx. `useToast`
 * is overridden with a spy so the copy is asserted verbatim; `uploadFiles` is
 * mocked to reject with a REAL UploadBatchError (via importOriginal) so the
 * page's `instanceof` branch is the one under test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { FileEntryInfo } from "@/lib/types";

const EXISTING: FileEntryInfo = {
  name: "already-here.txt",
  path: "/already-here.txt",
  size: 4,
  isDirectory: false,
  mimeType: "text/plain",
  modifiedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
} as unknown as FileEntryInfo;

const refreshSpy = vi.fn().mockResolvedValue(undefined);
const toastSpy = vi.fn();

vi.mock("@/lib/hooks/useFiles", () => ({
  useFiles: () => ({ files: [EXISTING], error: null, isLoading: false, refresh: refreshSpy }),
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

vi.mock("@/components/Toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/Toast")>();
  return { ...actual, useToast: () => ({ toast: toastSpy }) };
});

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
import { uploadFiles, UploadBatchError } from "@/lib/api";

const RAW_SERVER_TEXT = "Upload failed: multer LIMIT_FILE_SIZE at layer.js:71";

/** Pick a selection and fire it through the page's hidden file input. */
function chooseFiles(count: number) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  expect(input).toBeTruthy();
  const files = Array.from(
    { length: count },
    (_, i) => new File(["x"], `pick-${i}.txt`),
  );
  fireEvent.change(input, { target: { files } });
}

describe("Files page — partial-upload toast tells the continue-past truth (WARP-1843)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it("says how many files didn't upload, composed from the typed error", async () => {
    // 41 files, batch 2 of 3 failed mid-run: 21 landed, 20 did not.
    vi.mocked(uploadFiles).mockRejectedValueOnce(
      new UploadBatchError(
        21,
        41,
        new Error(RAW_SERVER_TEXT),
        Array.from({ length: 20 }, (_, i) => `pick-${20 + i}.txt`),
      ),
    );
    render(<FilesPage />);

    chooseFiles(41);

    await waitFor(() => expect(uploadFiles).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        "Uploaded 21 of 41 files. 20 didn't upload — try again to finish.",
      ),
    );
    // WARP-1666 posture, unchanged: the batches that landed are on the box —
    // refresh so they actually appear.
    await waitFor(() => expect(refreshSpy).toHaveBeenCalled());
    // The raw server message never reaches the user.
    for (const [message] of toastSpy.mock.calls) {
      expect(String(message)).not.toContain("multer");
      expect(String(message)).not.toContain("layer.js");
    }
  });

  it("keeps the translateError path when nothing landed at all", async () => {
    vi.mocked(uploadFiles).mockRejectedValueOnce(
      new UploadBatchError(
        0,
        3,
        new Error(RAW_SERVER_TEXT),
        ["pick-0.txt", "pick-1.txt", "pick-2.txt"],
      ),
    );
    render(<FilesPage />);

    chooseFiles(3);

    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    for (const [message] of toastSpy.mock.calls) {
      // No partial-success claim when zero files landed…
      expect(String(message)).not.toMatch(/Uploaded \d+ of \d+/);
      // …and still no raw server text.
      expect(String(message)).not.toContain("multer");
    }
  });
});
