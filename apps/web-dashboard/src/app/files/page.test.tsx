/**
 * WARP-883 (QA finding #3) — FilesPage render smoke test.
 *
 * The leaf-component suites (SpaceSwitcher / ShareDialog) render those pieces
 * in isolation and never mount the page that wires them together. That gap let
 * a temporal-dead-zone bug ship: a `useEffect` listed `loadExistingShares` in
 * its dependency array before the `const loadExistingShares = useCallback(...)`
 * was declared, so the page threw `ReferenceError: Cannot access
 * 'loadExistingShares' before initialization` on FIRST render — white-screening
 * the whole Files surface (incl. the SpaceSwitcher).
 *
 * This test mounts the real <FilesPage/> with the data hooks mocked and asserts
 * it renders without throwing AND the SpaceSwitcher + file list appear. It FAILS
 * (ReferenceError) before the hoist fix and PASSES after.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { FileEntryInfo, FileSpace } from "@/lib/types";

// ── next/navigation — the page reads ?path= via useSearchParams ──
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/files",
}));

// ── Data hooks ──
const PERSONAL: FileSpace = { id: "personal", name: "My Files", root: "/" };
const SHARED: FileSpace = {
  id: "shared",
  name: "Household",
  root: "/Household",
  kind: "household",
  state: "active",
};

const FILES: FileEntryInfo[] = [
  {
    name: "report.pdf",
    path: "/report.pdf",
    isDirectory: false,
    size: 2048,
    modifiedAt: "2026-04-16T00:00:00.000Z",
    mimeType: "application/pdf",
  },
];

vi.mock("@/lib/hooks/useSpaces", () => ({
  // shared available so the SpaceSwitcher actually renders (2+ spaces).
  useSpaces: () => ({ spaces: [PERSONAL, SHARED], sharedAvailable: true, error: undefined, isLoading: false }),
}));

vi.mock("@/lib/hooks/useFiles", () => ({
  useFiles: () => ({ files: FILES, error: undefined, isLoading: false, refresh: vi.fn() }),
}));

vi.mock("@/lib/hooks/useFavorites", () => ({
  useFavorites: () => ({ items: [], error: undefined, isLoading: false, refresh: vi.fn() }),
}));

vi.mock("@/lib/hooks/useFileRealtime", () => ({
  useFileRealtime: () => undefined,
}));

// ShellPage's status chip pulls device/health via useDevice (SWR → network).
// Stub it so the page chrome renders without hitting the api in the test env.
vi.mock("@/lib/hooks/useDevice", () => ({
  useDevice: () => ({
    device: { id: "box-1", name: "Droplet", status: "online" },
    devices: [{ id: "box-1", name: "Droplet", status: "online" }],
    health: { status: "ok" },
    isLoading: false,
    error: undefined,
  }),
}));

vi.mock("@/lib/hooks/useFileManager", () => ({
  useFileManager: () => ({
    selection: new Set<string>(),
    selectedPaths: [],
    selectedCount: 0,
    isSelected: () => false,
    selectOnly: vi.fn(),
    toggleSelection: vi.fn(),
    selectAll: vi.fn(),
    clearSelection: vi.fn(),
    renamingPath: null,
    beginRename: vi.fn(),
    endRename: vi.fn(),
    clipboard: null,
    cut: vi.fn(),
    copy: vi.fn(),
    clearClipboard: vi.fn(),
    viewMode: "list",
    setViewMode: vi.fn(),
  }),
}));

// Spread the real api module (so every export the page chrome references — e.g.
// ShellPage's fetchSystemHealth — stays defined) but override the network-
// touching calls that fire at render so nothing hits a server in the test env.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchShares: vi.fn().mockResolvedValue([]),
    fetchSystemHealth: vi.fn().mockResolvedValue({ status: "ok" }),
  };
});

import FilesPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<FilesPage /> (WARP-883 smoke)", () => {
  it("mounts without throwing (no temporal-dead-zone on loadExistingShares)", () => {
    // The bug surfaced as a render-time ReferenceError; a successful render is
    // the assertion. render() rethrows any error raised during the render pass.
    expect(() => render(<FilesPage />)).not.toThrow();
  });

  it("renders the SpaceSwitcher when a shared space is available", () => {
    render(<FilesPage />);
    expect(screen.getByRole("tab", { name: /my files/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /household/i })).toBeInTheDocument();
  });

  it("renders the file list rows", () => {
    render(<FilesPage />);
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
  });
});
