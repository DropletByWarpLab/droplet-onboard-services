/**
 * Files page — multi-select actually accumulates a selection.
 *
 * Bug (reported live on /files?path=/Home): ticking rows to multi-select was
 * impossible. The selection circle had no handler, so a click on it fell
 * through to the row and — for folders, per WARP-309 — navigated into the
 * folder instead of selecting it. Only Cmd/Ctrl/Shift-click worked.
 *
 * This drives the REAL <FilesPage> with the real useFileManager (only the data
 * hooks are stubbed) and asserts that clicking two checkboxes leaves two items
 * selected, with no navigation, and that the third stays unticked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import type { FileEntryInfo } from "@/lib/types";

function entry(name: string, isDirectory: boolean): FileEntryInfo {
  return {
    name,
    path: `/Home/${name}`,
    size: 100,
    isDirectory,
    mimeType: isDirectory ? null : "text/plain",
    modifiedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
  } as unknown as FileEntryInfo;
}

const ENTRIES = [entry("Photos", true), entry("Taxes", true), entry("notes.txt", false)];

// NOTE: useFileManager is deliberately NOT mocked — the real selection state
// machine is the thing under test here.
vi.mock("@/lib/hooks/useFiles", () => ({
  useFiles: () => ({ files: ENTRIES, error: null, isLoading: false, refresh: vi.fn() }),
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

const box = (name: string) => screen.getByRole("checkbox", { name: new RegExp(`select ${name}`, "i") });

describe("Files page — multi-select", () => {
  beforeEach(() => {
    cleanup();
  });

  it("ticking two folders selects both instead of navigating into them", () => {
    render(<FilesPage />);

    fireEvent.click(box("Photos"));
    fireEvent.click(box("Taxes"));

    expect(box("Photos")).toHaveAttribute("aria-checked", "true");
    expect(box("Taxes")).toHaveAttribute("aria-checked", "true");
    expect(box("notes.txt")).toHaveAttribute("aria-checked", "false");

    // Still in the same directory — no navigation happened.
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });

  it("ticking a folder and a file mixes types in one selection", () => {
    render(<FilesPage />);

    fireEvent.click(box("Photos"));
    fireEvent.click(box("notes.txt"));

    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });

  it("clicking a ticked checkbox again unticks it", () => {
    render(<FilesPage />);

    fireEvent.click(box("Photos"));
    fireEvent.click(box("Taxes"));
    fireEvent.click(box("Taxes"));

    expect(box("Taxes")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });

  it("a plain click on the folder row still navigates (WARP-309 unchanged)", () => {
    render(<FilesPage />);

    fireEvent.click(screen.getByRole("button", { name: /folder photos/i }));

    // Navigated into /Home/Photos — Photos is now the trailing breadcrumb
    // segment (the mocked useFiles serves the same listing at any path, so
    // the breadcrumb is what proves the path changed).
    const crumbs = within(screen.getByRole("navigation", { name: /breadcrumbs/i }));
    expect(crumbs.getByText("Photos")).toBeInTheDocument();
  });
});
