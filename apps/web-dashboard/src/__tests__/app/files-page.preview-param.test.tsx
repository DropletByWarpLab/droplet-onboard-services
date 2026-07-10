/**
 * Files page — `?preview=<path>` deep link (WARP-1143).
 *
 * The Home "Recent files" widget deep-links a file row to
 * /files?path=<parent>&preview=<path>. Once the folder listing loads, the
 * page must select + open that file in the rich PreviewPane. A target that
 * no longer resolves (deleted/unindexed since the recents snapshot) must
 * fail with a toast — not silently.
 *
 * Mock scaffolding mirrors files-page.doubleclick-preview.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { FileEntryInfo } from "@/lib/types";

const sampleFile: FileEntryInfo = {
  name: "notes.txt",
  path: "/notes.txt",
  size: 100,
  isDirectory: false,
  mimeType: "text/plain",
  modifiedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
} as FileEntryInfo;

// next/navigation — drive useSearchParams to simulate the deep link.
const searchParamsRef: { current: URLSearchParams } = {
  current: new URLSearchParams(),
};
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => searchParamsRef.current,
  usePathname: () => "/files",
}));

// Toast spy so the unresolvable-target case is observable.
const toastSpy = vi.fn();
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

// ── Data hooks: render exactly one file, no folders ──
vi.mock("@/lib/hooks/useFiles", () => ({
  useFiles: () => ({
    files: [sampleFile],
    error: null,
    isLoading: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/lib/hooks/useFileManager", () => ({
  useFileManager: () => ({
    selectedPaths: [],
    selectedCount: 0,
    clipboard: null,
    renamingPath: null,
    isSelected: () => false,
    toggleSelection: vi.fn(),
    selectOnly: vi.fn(),
    clearSelection: vi.fn(),
    clearClipboard: vi.fn(),
    beginRename: vi.fn(),
    endRename: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
  }),
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

// ShellPage's status chip fetches devices via useDevice — stub it so the
// shell renders without a network round-trip.
vi.mock("@/lib/hooks/useDevice", () => ({
  useDevice: () => ({
    device: { hostname: "droplet" },
    devices: [],
    health: undefined,
    isLoading: false,
    error: null,
  }),
}));

// ── Network boundary: keep every real export (ShellPage + the panels pull
// several), but neutralise the URL helpers + mutators so nothing escapes.
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

// Keep the real auth surface but neutralise the network fetch and supply a
// logged-in user so useAuth() doesn't throw outside an AuthProvider.
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

describe("Files page ?preview= deep link (WARP-1143)", () => {
  beforeEach(() => {
    cleanup();
    toastSpy.mockReset();
    searchParamsRef.current = new URLSearchParams();
  });

  it("opens the PreviewPane for the deep-linked file once the listing loads", () => {
    searchParamsRef.current = new URLSearchParams(
      "path=%2F&preview=%2Fnotes.txt",
    );
    render(<FilesPage />);

    // PreviewPane modal is identified by its "Close preview" control.
    expect(
      screen.getByRole("button", { name: /close preview/i }),
    ).toBeInTheDocument();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("toasts (not silently) when the deep-linked file no longer exists", () => {
    searchParamsRef.current = new URLSearchParams(
      "path=%2F&preview=%2Fgone.txt",
    );
    render(<FilesPage />);

    expect(toastSpy).toHaveBeenCalledWith(
      expect.stringMatching(/moved or deleted/i),
    );
    expect(
      screen.queryByRole("button", { name: /close preview/i }),
    ).not.toBeInTheDocument();
  });

  it("does nothing without a preview param", () => {
    searchParamsRef.current = new URLSearchParams("path=%2F");
    render(<FilesPage />);

    expect(toastSpy).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /close preview/i }),
    ).not.toBeInTheDocument();
  });
});
