/**
 * WARP-1912 — Undo on the post-upload confirmation toast.
 *
 * A full-success upload now confirms itself with a success toast carrying an
 * Undo action. Undo deletes EXACTLY the just-uploaded batch — the manifest
 * `runUpload` accounted (space-relative write-route paths, the vocabulary
 * `deleteFile` takes) — for the space the upload targeted, then re-lists.
 * A delete that fails partway reports what remains instead of claiming a
 * clean undo.
 *
 * Mock stack modeled on files-page.upload-partial-toast.test.tsx: `useToast`
 * is a spy capturing the action argument; `uploadFiles` / `deleteFile` are
 * mocked; the REAL runUpload composes the manifest under test.
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
import { uploadFiles, deleteFile, UploadBatchError } from "@/lib/api";

type ToastAction = { label: string; onClick: () => void };

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

/** The one toast call that carried an action, or undefined. */
function actionToast(): [string, string | undefined, ToastAction] | undefined {
  return toastSpy.mock.calls.find(
    (call): call is [string, string | undefined, ToastAction] =>
      typeof call[2]?.onClick === "function",
  );
}

describe("Files page — Undo on the post-upload confirmation toast (WARP-1912)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    vi.mocked(uploadFiles).mockResolvedValue(undefined);
    vi.mocked(deleteFile).mockResolvedValue(undefined);
  });

  it("confirms a full-success upload with a success toast carrying Undo", async () => {
    render(<FilesPage />);

    chooseFiles(2);

    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    const call = actionToast();
    expect(call).toBeDefined();
    expect(call?.[0]).toBe("Uploaded 2 files.");
    expect(call?.[1]).toBe("success");
    expect(call?.[2].label).toBe("Undo");
  });

  it("Undo deletes exactly the uploaded batch, re-lists, and confirms", async () => {
    render(<FilesPage />);

    chooseFiles(2);

    await waitFor(() => expect(actionToast()).toBeDefined());
    refreshSpy.mockClear();

    actionToast()?.[2].onClick();

    await waitFor(() => expect(deleteFile).toHaveBeenCalledTimes(2));
    expect(vi.mocked(deleteFile).mock.calls).toEqual([
      ["/pick-0.txt", "personal"],
      ["/pick-1.txt", "personal"],
    ]);
    await waitFor(() => expect(refreshSpy).toHaveBeenCalled());
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith("Removed 2 uploaded files.", "info"),
    );
  });

  it("a partial undo failure reports what remains", async () => {
    vi.mocked(deleteFile)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("423 locked"));
    render(<FilesPage />);

    chooseFiles(2);

    await waitFor(() => expect(actionToast()).toBeDefined());

    actionToast()?.[2].onClick();

    await waitFor(() => expect(deleteFile).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        "Removed 1 of 2 uploaded files — 1 couldn't be removed.",
      ),
    );
    // The raw server text never reaches the user.
    for (const [message] of toastSpy.mock.calls) {
      expect(String(message)).not.toContain("423");
    }
  });

  it("offers no Undo when the run only partially landed", async () => {
    vi.mocked(uploadFiles).mockRejectedValueOnce(
      new UploadBatchError(1, 2, new Error("boom"), ["pick-1.txt"]),
    );
    render(<FilesPage />);

    chooseFiles(2);

    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    expect(actionToast()).toBeUndefined();
  });
});
