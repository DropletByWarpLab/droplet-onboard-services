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

/** `tree` maps a relative directory ("" = root) to its file names. */
function folderDrop(rootName: string, tree: Record<string, string[]>) {
  interface E {
    isFile: boolean;
    isDirectory: boolean;
    name: string;
    file?: (cb: (f: File) => void) => void;
    createReader?: () => { readEntries: (cb: (e: E[]) => void) => void };
  }
  const fileEntry = (name: string): E => ({
    isFile: true,
    isDirectory: false,
    name,
    file: (cb) => cb(new File(["x"], name)),
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
    const files = (tree[prefix] ?? []).map(fileEntry);
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
