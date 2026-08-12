/**
 * WARP-1876 — bulk upload on the Files page.
 *
 * The page already had a dropzone, a multi-select picker, a percentage
 * bar and the WARP-1666/1843 partial-failure toast. What it did NOT have:
 *
 *   · a drop target anywhere but the file-list column, so the breadcrumbs,
 *     the storage tiles and the detail panel all swallowed a drop;
 *   · any way to add a FOLDER — a dropped directory arrived as a
 *     zero-byte File named after the folder and was uploaded as junk.
 *
 * Folders are composed from the endpoints that already exist: mkdir
 * shallow-first, then one upload call per directory. This asserts the
 * calls that reach the wire and that the partial-failure copy still tells
 * the truth once a run spans several of them.
 *
 * Mock stack mirrors files-page.upload-partial-toast.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
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
vi.mock("@/lib/hooks/useFileRealtime", () => ({ useFileRealtime: vi.fn() }));
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
    uploadFiles: vi.fn().mockResolvedValue(undefined),
    createDirectory: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn(),
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
import { uploadFiles, createDirectory, UploadBatchError } from "@/lib/api";

// ── Drop-event builders ────────────────────────────────────────────────

function flatDrop(names: string[]) {
  return { dataTransfer: { files: names.map((n) => new File(["x"], n)) } };
}

/**
 * `tree` maps a relative directory ("" = root) to its file names; a
 * directory with an empty list is an EMPTY folder in the dropped tree.
 * `unreadable` maps the same directories to names the browser refuses to
 * hand over — an online-only OneDrive/iCloud placeholder.
 */
function folderDrop(
  rootName: string,
  tree: Record<string, string[]>,
  unreadable: Record<string, string[]> = {}
) {
  interface E {
    isFile: boolean;
    isDirectory: boolean;
    name: string;
    file?: (cb: (f: File) => void, onError?: (e: unknown) => void) => void;
    createReader?: () => { readEntries: (cb: (e: E[]) => void) => void };
  }
  const fileEntry = (name: string): E => ({
    isFile: true,
    isDirectory: false,
    name,
    file: (cb) => cb(new File(["x"], name)),
  });
  const unreadableEntry = (name: string): E => ({
    isFile: true,
    isDirectory: false,
    name,
    file: (_cb, onError) => onError?.(new Error("not available offline")),
  });
  const dirEntry = (name: string, children: E[]): E => {
    let cursor = 0;
    return {
      isFile: false,
      isDirectory: true,
      name,
      createReader: () => ({
        readEntries: (cb) => {
          const page = children.slice(cursor, cursor + 100);
          cursor += page.length;
          cb(page);
        },
      }),
    };
  };
  const build = (prefix: string): E[] => {
    const files = [
      ...(tree[prefix] ?? []).map(fileEntry),
      ...(unreadable[prefix] ?? []).map(unreadableEntry),
    ];
    const subdirs = Object.keys(tree)
      .filter((k) => k !== prefix && (prefix === "" ? !k.includes("/") : k.startsWith(`${prefix}/`)))
      .filter((k) => k.slice(prefix === "" ? 0 : prefix.length + 1).split("/").length === 1)
      .map((k) => dirEntry(k.split("/").pop() as string, build(k)));
    return [...files, ...subdirs];
  };
  return {
    dataTransfer: {
      items: [{ kind: "file", webkitGetAsEntry: () => dirEntry(rootName, build("")) }],
      files: [],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  vi.mocked(uploadFiles).mockResolvedValue(undefined);
  vi.mocked(createDirectory).mockResolvedValue(undefined);
});

describe("Files page — the whole page is a drop target (WARP-1876)", () => {
  it("accepts a drop on the breadcrumb bar, not just the file list", async () => {
    render(<FilesPage />);

    // The breadcrumbs sit ABOVE the list column the dropzone used to wrap.
    fireEvent.drop(screen.getByLabelText("Breadcrumbs"), flatDrop(["a.txt", "b.txt"]));

    await waitFor(() => expect(uploadFiles).toHaveBeenCalledTimes(1));
    const [dir, files] = vi.mocked(uploadFiles).mock.calls[0];
    expect(dir).toBe("/");
    expect(Array.from(files).map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
    // A flat drop needs no directories.
    expect(createDirectory).not.toHaveBeenCalled();
  });

  it("shows the drag-over affordance for the whole page", () => {
    render(<FilesPage />);
    fireEvent.dragEnter(screen.getByLabelText("Breadcrumbs"));
    expect(screen.getByText("Drop files or folders to upload")).toBeInTheDocument();
  });
});

describe("Files page — dropping a folder (WARP-1876)", () => {
  it("creates the directories shallow-first, then uploads per directory", async () => {
    render(<FilesPage />);

    fireEvent.drop(
      screen.getByLabelText("Breadcrumbs"),
      folderDrop("Reports", {
        "": ["readme.txt"],
        Q1: ["jan.csv", "feb.csv"],
      })
    );

    await waitFor(() => expect(uploadFiles).toHaveBeenCalledTimes(2));

    // MKCOL 409s when an intermediate collection is missing — parent first.
    expect(vi.mocked(createDirectory).mock.calls.map((c) => c[0])).toEqual([
      "/Reports",
      "/Reports/Q1",
    ]);

    const byDir = Object.fromEntries(
      vi.mocked(uploadFiles).mock.calls.map((c) => [c[0], Array.from(c[1]).map((f) => f.name)])
    );
    expect(byDir).toEqual({
      "/Reports": ["readme.txt"],
      "/Reports/Q1": ["jan.csv", "feb.csv"],
    });
  });

  it("aggregates the partial-failure count across directories", async () => {
    // Root group lands, the Q1 group half-fails.
    vi.mocked(uploadFiles)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new UploadBatchError(1, 2, new Error("multer LIMIT_FILE_SIZE"), ["feb.csv"])
      );

    render(<FilesPage />);

    fireEvent.drop(
      screen.getByLabelText("Breadcrumbs"),
      folderDrop("Reports", { "": ["readme.txt"], Q1: ["jan.csv", "feb.csv"] })
    );

    // 3 files dropped, 2 landed (readme + jan), 1 did not.
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        "Uploaded 2 of 3 files. 1 didn't upload — try again to finish."
      )
    );
    await waitFor(() => expect(refreshSpy).toHaveBeenCalled());
    for (const [message] of toastSpy.mock.calls) {
      expect(String(message)).not.toContain("multer");
    }
  });

  it("keeps the outcome message when the listing refresh rejects", async () => {
    // `refresh()` is an SWR revalidation — it can reject on its own (the box
    // rebooting mid-upload, a 503 from the listing route). The files that
    // landed still landed, so a stale listing must not swallow the toast
    // that says so, nor escape as an unhandled rejection.
    refreshSpy.mockRejectedValueOnce(new Error("revalidate failed"));
    vi.mocked(uploadFiles).mockRejectedValueOnce(
      new UploadBatchError(1, 2, new Error("boom"), ["b.txt"])
    );

    render(<FilesPage />);
    fireEvent.drop(screen.getByLabelText("Breadcrumbs"), flatDrop(["a.txt", "b.txt"]));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        "Uploaded 1 of 2 files. 1 didn't upload — try again to finish."
      )
    );
  });
});

/**
 * WARP-1876 review — a folder walk that discards what it cannot read
 * reports a partial migration as a complete one, and an empty folder never
 * arrives at all.
 */
describe("Files page — a dropped folder arrives whole, or says why not", () => {
  it("tells the user about the documents it could not read", async () => {
    render(<FilesPage />);

    // The office case: three documents, one an online-only placeholder.
    fireEvent.drop(
      screen.getByLabelText("Breadcrumbs"),
      folderDrop("Docs", { "": ["a.pdf", "b.pdf"] }, { "": ["offline.docx"] })
    );

    await waitFor(() => expect(uploadFiles).toHaveBeenCalledTimes(1));
    // Both readable files still upload — the run is not abandoned.
    expect(Array.from(vi.mocked(uploadFiles).mock.calls[0][1]).map((f) => f.name)).toEqual([
      "a.pdf",
      "b.pdf",
    ]);
    // …and the third one is named, not rounded away into a clean success.
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        "Uploaded 2 of 3 files. 1 item couldn't be read and wasn't uploaded."
      )
    );
  });

  it("creates the folders that hold no files", async () => {
    render(<FilesPage />);

    fireEvent.drop(
      screen.getByLabelText("Breadcrumbs"),
      folderDrop("Clients", { "": [], Acme: ["contract.pdf"], Bravo: [] })
    );

    await waitFor(() => expect(uploadFiles).toHaveBeenCalledTimes(1));
    // "Bravo" has no files, so nothing in the upload list mentions it —
    // it has to come from the walk's own record of the tree.
    expect(vi.mocked(createDirectory).mock.calls.map((c) => c[0])).toEqual([
      "/Clients",
      "/Clients/Acme",
      "/Clients/Bravo",
    ]);
  });

  it("gives a folder-only drop a voice instead of doing nothing visible", async () => {
    render(<FilesPage />);

    fireEvent.drop(
      screen.getByLabelText("Breadcrumbs"),
      folderDrop("Clients", { "": [], Acme: [], Bravo: [] })
    );

    await waitFor(() => expect(createDirectory).toHaveBeenCalledTimes(3));
    expect(uploadFiles).not.toHaveBeenCalled();
    // The folders ARE on the box now, so the listing has to be re-read.
    await waitFor(() => expect(refreshSpy).toHaveBeenCalled());
    expect(toastSpy).toHaveBeenCalledWith(
      "Created 3 folders. There were no files in them to upload."
    );
  });

  it("stays quiet when the drop carried nothing at all", async () => {
    render(<FilesPage />);

    fireEvent.drop(screen.getByLabelText("Breadcrumbs"), flatDrop([]));

    await waitFor(() => expect(uploadFiles).not.toHaveBeenCalled());
    // Dragging selected text across the page is not a failed upload.
    expect(toastSpy).not.toHaveBeenCalled();
    expect(createDirectory).not.toHaveBeenCalled();
  });
});

describe("Files page — bulk pickers in the header (WARP-1876)", () => {
  it("offers a folder picker alongside the multi-select file picker", () => {
    render(<FilesPage />);
    expect(screen.getByRole("button", { name: "Upload folder" })).toBeInTheDocument();
    const inputs = document.querySelectorAll('input[type="file"]');
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toHaveAttribute("multiple");
  });
});
