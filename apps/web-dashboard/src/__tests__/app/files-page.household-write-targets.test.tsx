/**
 * WARP-1200 / WARP-1262 (T10) — Files: writes issued while the Household tab
 * is active must target the SHARED space, not the personal one.
 *
 * WARP-1200 originally fixed this by pre-translating `currentPath` (space-
 * relative) to a HOME-relative path client-side before calling the write
 * APIs. WARP-1262 moves that resolution server-side: the write routes now
 * accept `?space=`/body `space` and resolve the operational path themselves
 * (`rootForSpace`), so the client just passes `currentPath` verbatim
 * alongside the active `space` — no more `toHomeRelativePath`.
 *
 * These tests drive the real <FilesPage> with its data hooks stubbed (mock
 * stack modeled on files-page.doubleclick-preview.test.tsx), switch to the
 * Household tab, and pin every write call to (space-relative path, "shared")
 * — plus a guard that the personal tab's calls stay space-omitted, byte-
 * identical to pre-WARP-883.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { FileEntryInfo, FileSpace } from "@/lib/types";

const PERSONAL: FileSpace = { id: "personal", name: "My Files", root: "/" };
const SHARED: FileSpace = {
  id: "shared",
  name: "Household",
  root: "/Household",
  kind: "household",
  state: "active",
};

// Listing entries carry HOME-relative paths (WARP-1140) — in the shared
// space the folder row for "Trips" reads "/Household/Trips".
const tripsFolder: FileEntryInfo = {
  name: "Trips",
  path: "/Household/Trips",
  size: 0,
  isDirectory: true,
  mimeType: "",
  modifiedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
} as FileEntryInfo;

// next/navigation is mocked globally in src/__tests__/setup.ts.

vi.mock("@/lib/hooks/useFiles", () => ({
  useFiles: () => ({
    files: [tripsFolder],
    error: null,
    isLoading: false,
    refresh: vi.fn(),
  }),
}));

// Clipboard pre-loaded so the SelectionToolbar's "Paste" affordance renders
// (paths are home-relative entry paths, exactly what fm.copy() captures).
vi.mock("@/lib/hooks/useFileManager", () => ({
  useFileManager: () => ({
    selectedPaths: [],
    selectedCount: 0,
    clipboard: { mode: "copy" as const, paths: ["/Household/report.pdf"] },
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

// Shared space available so the SpaceSwitcher tabs render.
vi.mock("@/lib/hooks/useSpaces", () => ({
  useSpaces: () => ({ spaces: [PERSONAL, SHARED], sharedAvailable: true }),
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
    uploadFiles: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn(),
    createDirectory: vi.fn().mockResolvedValue(undefined),
    getDownloadUrl: (p: string) => `/api/files/download?path=${p}`,
    getThumbnailUrl: (p: string) => `/api/files/thumbnail?path=${p}`,
    renameFile: vi.fn(),
    bulkDeleteFiles: vi.fn().mockResolvedValue([]),
    bulkMoveFiles: vi.fn().mockResolvedValue([]),
    bulkCopyFiles: vi.fn().mockResolvedValue([]),
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
import { uploadFiles, createDirectory, bulkCopyFiles } from "@/lib/api";

function switchToHousehold() {
  // WARP-1808 — the shared tab renders "Workspace" (the raw server name
  // "Household" stays in the fixture/data layer).
  fireEvent.click(screen.getByRole("tab", { name: /workspace/i }));
}

/** Drop a file onto the list area — bubbles up to the UploadZone's onDrop. */
function dropFile(onElement: HTMLElement) {
  const file = new File(["hello"], "hello.txt", { type: "text/plain" });
  fireEvent.drop(onElement, { dataTransfer: { files: [file] } });
}

describe("Files page — Household-tab writes thread the `space` param (WARP-1262/T10)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it("upload (drag-drop / Upload button share handleUpload) at the Household root passes the space-relative root + 'shared'", async () => {
    render(<FilesPage />);
    switchToHousehold();

    dropFile(screen.getByText("Trips"));

    await waitFor(() => expect(uploadFiles).toHaveBeenCalledTimes(1));
    const call = vi.mocked(uploadFiles).mock.calls[0];
    expect(call[0]).toBe("/");
    expect(call[3]).toBe("shared");
  });

  it("upload inside a Household subfolder passes the space-relative subfolder (no home-relative prefix)", async () => {
    render(<FilesPage />);
    switchToHousehold();

    // Enter the Trips folder: entry path is home-relative, currentPath
    // becomes the space-relative "/Trips" (WARP-1140). Drop on the row (the
    // breadcrumb now also says "Trips", so target the row's button role).
    fireEvent.doubleClick(screen.getByRole("button", { name: /folder trips/i }));
    dropFile(screen.getByRole("button", { name: /folder trips/i }));

    await waitFor(() => expect(uploadFiles).toHaveBeenCalledTimes(1));
    const call = vi.mocked(uploadFiles).mock.calls[0];
    expect(call[0]).toBe("/Trips");
    expect(call[3]).toBe("shared");
  });

  it("new folder created in the Household tab passes the space-relative destination + 'shared'", async () => {
    render(<FilesPage />);
    switchToHousehold();

    fireEvent.click(screen.getByRole("button", { name: /new folder/i }));
    fireEvent.change(screen.getByPlaceholderText(/folder name/i), {
      target: { value: "Tax docs" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => expect(createDirectory).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createDirectory).mock.calls[0]).toEqual(["/Tax docs", "shared"]);
  });

  it("pasting the clipboard in the Household tab converts the source to space-relative and targets the space-relative root + 'shared'", async () => {
    render(<FilesPage />);
    switchToHousehold();

    fireEvent.click(screen.getByRole("button", { name: /paste/i }));

    await waitFor(() => expect(bulkCopyFiles).toHaveBeenCalledTimes(1));
    // Clipboard held the home-relative "/Household/report.pdf" — converted to
    // "/report.pdf" (space-relative to the active Household space) before
    // being sent, alongside the space-relative destination root and "shared".
    expect(vi.mocked(bulkCopyFiles).mock.calls[0]).toEqual([
      ["/report.pdf"],
      "/",
      false,
      "shared",
    ]);
  });

  it("personal-tab writes omit `space` entirely (upload '/', mkdir '/name') — unchanged from pre-WARP-883", async () => {
    render(<FilesPage />);
    // No tab switch — personal is the default space.

    dropFile(screen.getByText("Trips"));
    await waitFor(() => expect(uploadFiles).toHaveBeenCalledTimes(1));
    const uploadCall = vi.mocked(uploadFiles).mock.calls[0];
    expect(uploadCall[0]).toBe("/");
    expect(uploadCall[3]).toBe("personal");

    fireEvent.click(screen.getByRole("button", { name: /new folder/i }));
    fireEvent.change(screen.getByPlaceholderText(/folder name/i), {
      target: { value: "Notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(createDirectory).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createDirectory).mock.calls[0]).toEqual(["/Notes", "personal"]);
  });
});
