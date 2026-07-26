/**
 * WARP-1555 — <FavoritesPage /> tells a failed fetch apart from an empty list.
 *
 * `useFavorites` always exposed `error`; the page destructured only
 * `{ items, isLoading, refresh }`, so a 500 / dead Nextcloud / expired token
 * rendered the EMPTY state: "No favorites yet". A user cannot tell that from
 * "we couldn't reach the box", and the empty copy actively misleads — it reads
 * as though their stars were lost.
 *
 * The hook is mocked; the page and <FileListSimple /> under it are real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { FileEntryInfo } from "@/lib/types";

// ── Data hook (mutable per-test state, read at render time) ──
const refresh = vi.fn();
const favoritesState: {
  items: FileEntryInfo[];
  isLoading: boolean;
  error: unknown;
} = { items: [], isLoading: false, error: undefined };

vi.mock("@/lib/hooks/useFavorites", () => ({
  useFavorites: () => ({
    items: favoritesState.items,
    isLoading: favoritesState.isLoading,
    error: favoritesState.error,
    refresh,
  }),
}));

// ShellPage's status chip pulls device/health over the network; stub it so the
// page chrome renders in the test env.
vi.mock("@/lib/hooks/useDevice", () => ({
  useDevice: () => ({
    device: { id: "box-1", name: "Droplet", status: "online" },
    devices: [{ id: "box-1", name: "Droplet", status: "online" }],
    health: { status: "ok" },
    isLoading: false,
    error: undefined,
  }),
}));

// Spread the real api module (the page uses getDownloadUrl / toggleFavorite)
// and only stub the call ShellPage fires at render.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchSystemHealth: vi.fn().mockResolvedValue({ status: "ok" }),
  };
});

import FavoritesPage from "./page";

const FILE: FileEntryInfo = {
  name: "budget.xlsx",
  path: "/Documents/budget.xlsx",
  isDirectory: false,
  size: 4096,
  modifiedAt: "2026-07-20T10:00:00.000Z",
  mimeType: "application/vnd.ms-excel",
};

beforeEach(() => {
  refresh.mockClear();
  favoritesState.items = [];
  favoritesState.isLoading = false;
  favoritesState.error = undefined;
});

describe("<FavoritesPage /> — fetch failure ≠ empty (WARP-1555)", () => {
  it("renders an error state, never the empty state, when the fetch fails", () => {
    favoritesState.error = new Error("Failed to fetch favorites: 500");
    render(<FavoritesPage />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/couldn't load your favorites/i)).toBeInTheDocument();
    expect(screen.queryByText(/no favorites yet/i)).not.toBeInTheDocument();
  });

  it("explains what happened instead of a bare 'something went wrong'", () => {
    favoritesState.error = new Error("boom");
    render(<FavoritesPage />);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/your favorites are still saved/i);
    expect(alert.textContent).not.toMatch(/something went wrong/i);
  });

  it("offers a retry that re-runs the fetch", () => {
    favoritesState.error = new Error("boom");
    render(<FavoritesPage />);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("still shows the empty state when the list is genuinely empty", () => {
    render(<FavoritesPage />);

    expect(screen.getByText(/no favorites yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the loading state while the first fetch is in flight", () => {
    favoritesState.isLoading = true;
    render(<FavoritesPage />);

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(screen.queryByText(/no favorites yet/i)).not.toBeInTheDocument();
  });

  it("keeps showing rows when a background refresh fails", () => {
    // SWR holds the last good data; blowing the list away over a failed poll
    // would be a worse lie than the one we're fixing.
    favoritesState.items = [FILE];
    favoritesState.error = new Error("poll failed");
    render(<FavoritesPage />);

    expect(screen.getByText("budget.xlsx")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
