/**
 * WARP-1247 — Move/Copy dialog must seed its destination from the
 * HOME-relative path, not the space-relative `currentPath`.
 *
 * Bug: PR #961 (WARP-1200) fixed upload / new-folder / paste to resolve
 * write destinations through `homeRelativeCurrentPath`, but the "Move
 * to… / Copy to…" dialog is a 4th write-destination path with the same
 * defect that #961 did NOT touch — it seeded `MoveCopyDialog`'s initial
 * `selectedPath` from the raw (space-relative) `currentPath`, while the
 * dialog's tree + `handleMoveCopyConfirm` (bulkMoveFiles / bulkCopyFiles)
 * are already home-relative. With the Household tab active in e.g.
 * "/Trips", confirming the stale default without re-picking a node moved
 * or copied files into the PERSONAL space instead of "/Household/Trips".
 *
 * This test drives the real <FilesPage> (mock stack modeled on
 * files-page.household-write-targets.test.tsx), switches to the
 * Household tab, navigates into a subfolder, opens Move (via the
 * SelectionToolbar) and confirms the default target immediately — the
 * same "don't re-pick" repro from the ticket. It fails before the fix
 * (target resolves to the personal "/Trips") and passes after.
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

const photo: FileEntryInfo = {
  name: "photo.jpg",
  path: "/Household/Trips/photo.jpg",
  size: 1024,
  isDirectory: false,
  mimeType: "image/jpeg",
  modifiedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
} as FileEntryInfo;

// next/navigation is mocked globally in src/__tests__/setup.ts.

vi.mock("@/lib/hooks/useFiles", () => ({
  useFiles: () => ({
    files: [tripsFolder, photo],
    error: null,
    isLoading: false,
    refresh: vi.fn(),
  }),
}));

// One item selected so the SelectionToolbar's Move/Copy buttons render.
vi.mock("@/lib/hooks/useFileManager", () => ({
  useFileManager: () => ({
    selectedPaths: ["/Household/Trips/photo.jpg"],
    selectedCount: 1,
    clipboard: null,
    renamingPath: null,
    isSelected: (p: string) => p === "/Household/Trips/photo.jpg",
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
// several — incl. fetchFiles, which the dialog's tree calls on mount), but
// neutralise the mutators + the tree's root listing so nothing escapes.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchFiles: vi.fn().mockResolvedValue([]),
    createDirectory: vi.fn().mockResolvedValue(undefined),
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
import { bulkMoveFiles } from "@/lib/api";

function switchToHousehold() {
  // WARP-1808 — the shared tab renders "Workspace" (the raw server name
  // "Household" stays in the fixture/data layer).
  fireEvent.click(screen.getByRole("tab", { name: /workspace/i }));
}

describe("Files page — Move/Copy dialog seeds the home-relative target (WARP-1247)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it("confirming the default target from the Household/Trips subfolder moves into the shared subfolder, not the personal one", async () => {
    render(<FilesPage />);
    switchToHousehold();

    // Enter the Trips folder: entry path is home-relative, currentPath
    // becomes the space-relative "/Trips" (WARP-1140) — the exact repro
    // shape from the ticket.
    fireEvent.doubleClick(screen.getByRole("button", { name: /folder trips/i }));

    // Open the Move dialog via the SelectionToolbar (one item selected).
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    // Confirm the STALE DEFAULT immediately, without re-picking a tree
    // node — the exact "don't re-pick" repro from the ticket.
    await waitFor(() =>
      expect(screen.getByText("/Household/Trips")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: /move here/i }));

    await waitFor(() => expect(bulkMoveFiles).toHaveBeenCalledTimes(1));
    expect(vi.mocked(bulkMoveFiles).mock.calls[0]).toEqual([
      ["/Household/Trips/photo.jpg"],
      "/Household/Trips",
    ]);
  });

  it("personal-tab default target is unchanged (root '/')", async () => {
    render(<FilesPage />);
    // No tab switch — personal is the default space.

    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() => expect(screen.getAllByText("/").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /move here/i }));

    await waitFor(() => expect(bulkMoveFiles).toHaveBeenCalledTimes(1));
    expect(vi.mocked(bulkMoveFiles).mock.calls[0]).toEqual([
      ["/Household/Trips/photo.jpg"],
      "/",
    ]);
  });
});
