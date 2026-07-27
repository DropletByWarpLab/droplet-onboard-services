/**
 * WARP-1549 — <FavoritesPage /> says which library each favorite lives in,
 * and opens it there.
 *
 * A favorite is home-relative and nothing else: "/Finance/Q1/plan.xlsx" looked
 * exactly like a personal file, and the row click hand-built
 * `/files?path=…` — no `?space=` — so it always landed in the personal space.
 *
 * The hooks are mocked at the API boundary (`fetchSpaces`), so the real
 * `useSpaceAttribution` → resolver → `FileListSimple` chain is under test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { FileEntryInfo, FileSpacesResponse } from "@/lib/types";

const refresh = vi.fn();
const favoritesState: { items: FileEntryInfo[] } = { items: [] };

vi.mock("@/lib/hooks/useFavorites", () => ({
  useFavorites: () => ({
    items: favoritesState.items,
    isLoading: false,
    error: undefined,
    refresh,
  }),
}));

vi.mock("@/lib/hooks/useDevice", () => ({
  useDevice: () => ({
    device: { id: "box-1", name: "Droplet", status: "online" },
    devices: [{ id: "box-1", name: "Droplet", status: "online" }],
    health: { status: "ok" },
    isLoading: false,
    error: undefined,
  }),
}));

// The viewer belongs to one department and one team, alongside their home.
// `vi.hoisted` because the `vi.mock` factory below is hoisted above it.
const SPACES = vi.hoisted<FileSpacesResponse>(() => ({
  sharedAvailable: false,
  spaces: [
    { id: "personal", name: "My Files", root: "/" },
    {
      id: "dept:finance",
      name: "Finance",
      root: "/Finance",
      kind: "department",
      state: "active",
      right: "contributor",
      isMember: true,
    },
    {
      id: "dept:eng-platform",
      name: "Platform",
      parentName: "Engineering",
      root: "/Engineering — Platform",
      kind: "team",
      state: "active",
      right: "reader",
      isMember: true,
    },
  ],
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchSystemHealth: vi.fn().mockResolvedValue({ status: "ok" }),
    fetchSpaces: vi.fn().mockResolvedValue(SPACES),
  };
});

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/files/favorites",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
}));

import FavoritesPage from "./page";

function file(overrides: Partial<FileEntryInfo>): FileEntryInfo {
  return {
    name: "plan.xlsx",
    path: "/Finance/Q1/plan.xlsx",
    isDirectory: false,
    size: 4096,
    mimeType: "application/vnd.ms-excel",
    modifiedAt: "2026-07-20T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  pushMock.mockClear();
  favoritesState.items = [];
});

describe("<FavoritesPage /> — library attribution (WARP-1549)", () => {
  it("names the department a favorite lives in", async () => {
    favoritesState.items = [file({})];
    render(<FavoritesPage />);

    expect(await screen.findByText("Finance")).toBeInTheDocument();
  });

  it("names a team as '<Parent> — <Team>', the mount name the user sees", async () => {
    favoritesState.items = [
      file({ name: "api.md", path: "/Engineering — Platform/specs/api.md" }),
    ];
    render(<FavoritesPage />);

    expect(await screen.findByText("Engineering — Platform")).toBeInTheDocument();
  });

  it("shows the location INSIDE the library, not the repeated mount name", async () => {
    favoritesState.items = [file({})];
    render(<FavoritesPage />);

    await screen.findByText("Finance");
    expect(screen.getByText("/Q1")).toBeInTheDocument();
    expect(screen.queryByText("/Finance/Q1")).not.toBeInTheDocument();
  });

  it("says nothing at all about a personal file — no chip, plain path", async () => {
    favoritesState.items = [file({ name: "budget.xlsx", path: "/Documents/budget.xlsx" })];
    render(<FavoritesPage />);

    expect(await screen.findByText("/Documents")).toBeInTheDocument();
    expect(screen.queryByText("My Files")).not.toBeInTheDocument();
  });

  it("opens a library file IN ITS LIBRARY when the row is clicked", async () => {
    favoritesState.items = [file({})];
    render(<FavoritesPage />);
    await screen.findByText("Finance");

    fireEvent.click(screen.getByText("plan.xlsx"));

    // The pair, not just the path: without ?space= the Files page lands in
    // the personal space and the library is never opened.
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(
        "/files?space=dept%3Afinance&path=%2FQ1"
      )
    );
  });

  it("keeps the plain personal URL shape for a personal file", async () => {
    favoritesState.items = [file({ name: "budget.xlsx", path: "/Documents/budget.xlsx" })];
    render(<FavoritesPage />);
    await screen.findByText("/Documents");

    fireEvent.click(screen.getByText("budget.xlsx"));

    expect(pushMock).toHaveBeenCalledWith("/files?path=%2FDocuments");
  });

  it("opens a favorited FOLDER as itself, in its library", async () => {
    favoritesState.items = [
      file({ name: "Q1", path: "/Finance/Q1", isDirectory: true, size: 0 }),
    ];
    render(<FavoritesPage />);
    await screen.findByText("Finance");

    fireEvent.click(screen.getByText("Q1"));

    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(
        "/files?space=dept%3Afinance&path=%2FQ1"
      )
    );
  });
});
