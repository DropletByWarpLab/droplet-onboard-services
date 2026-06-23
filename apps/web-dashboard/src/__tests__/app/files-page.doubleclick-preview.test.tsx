/**
 * Files — double-clicking a file opens the rich PreviewPane modal.
 *
 * Bug (Samantha QA #bugs): double-clicking a file row opened the info
 * sidebar (setSelectedFile) instead of the rich preview modal. The
 * sidebar is the single-click affordance; double-click (and the
 * context-menu / sidebar "Preview" actions) should open PreviewPane.
 *
 * This test drives the real <FilesPage> with its hooks stubbed and
 * asserts that a double-click on a FILE row mounts the PreviewPane modal
 * (identified by its "Close preview" control), not the info sidebar.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { FileEntryInfo } from "@/lib/types";

const sampleFile: FileEntryInfo = {
  name: "notes.txt",
  path: "/notes.txt",
  size: 100,
  isDirectory: false,
  mimeType: "text/plain",
  modifiedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
} as FileEntryInfo;

// next/navigation is mocked globally in src/__tests__/setup.ts
// (useSearchParams → empty params, usePathname → "/").

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

// Keep the real auth surface (the sidebar panels import several helpers),
// but neutralise the network fetch and supply a logged-in user so useAuth()
// doesn't throw outside an AuthProvider.
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

describe("Files page — double-click opens the rich preview (Samantha QA #bugs)", () => {
  beforeEach(() => {
    cleanup();
  });

  it("double-clicking a file row opens the PreviewPane modal, not the info sidebar", () => {
    render(<FilesPage />);

    const row = screen.getByRole("button", { name: /file notes\.txt/i });
    fireEvent.doubleClick(row);

    // PreviewPane modal is identified by its "Close preview" control.
    expect(
      screen.getByRole("button", { name: /close preview/i })
    ).toBeInTheDocument();
  });

  it("single-clicking a file row opens the info sidebar, not the preview modal", () => {
    render(<FilesPage />);

    const row = screen.getByRole("button", { name: /file notes\.txt/i });
    fireEvent.click(row);

    // Sidebar shows a Share… action; the preview modal does not exist.
    expect(
      screen.getByRole("button", { name: /share/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /close preview/i })
    ).not.toBeInTheDocument();
  });
});
