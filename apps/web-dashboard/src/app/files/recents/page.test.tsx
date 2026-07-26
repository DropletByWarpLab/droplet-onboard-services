/**
 * WARP-1555 — <RecentsPage /> tells a failed fetch apart from an empty list.
 *
 * `useRecents` always exposed `error`; the page destructured only
 * `{ items, isLoading }`, so any read failure fell through to
 * "No recent files" — indistinguishable from a brand-new box.
 *
 * The hook is mocked; the page and <FileListSimple /> under it are real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { FileEntryInfo } from "@/lib/types";

// ── Data hook (mutable per-test state, read at render time) ──
const refresh = vi.fn();
const recentsState: {
  items: FileEntryInfo[];
  isLoading: boolean;
  error: unknown;
} = { items: [], isLoading: false, error: undefined };

vi.mock("@/lib/hooks/useRecents", () => ({
  useRecents: () => ({
    items: recentsState.items,
    isLoading: recentsState.isLoading,
    error: recentsState.error,
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

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchSystemHealth: vi.fn().mockResolvedValue({ status: "ok" }),
  };
});

import RecentsPage from "./page";

const FILE: FileEntryInfo = {
  name: "notes.md",
  path: "/notes.md",
  isDirectory: false,
  size: 512,
  modifiedAt: new Date().toISOString(),
  mimeType: "text/markdown",
};

beforeEach(() => {
  refresh.mockClear();
  recentsState.items = [];
  recentsState.isLoading = false;
  recentsState.error = undefined;
});

describe("<RecentsPage /> — fetch failure ≠ empty (WARP-1555)", () => {
  it("renders an error state, never the empty state, when the fetch fails", () => {
    recentsState.error = new Error("Failed to fetch recents: 500");
    render(<RecentsPage />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/couldn't load your recent files/i)).toBeInTheDocument();
    expect(screen.queryByText(/no recent files/i)).not.toBeInTheDocument();
  });

  it("explains what happened instead of a bare 'something went wrong'", () => {
    recentsState.error = new Error("boom");
    render(<RecentsPage />);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/your files are untouched/i);
    expect(alert.textContent).not.toMatch(/something went wrong/i);
  });

  it("offers a retry that re-runs the fetch", () => {
    recentsState.error = new Error("boom");
    render(<RecentsPage />);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("still shows the empty state when nothing has been touched recently", () => {
    render(<RecentsPage />);

    expect(screen.getByText(/no recent files/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the loading state while the first fetch is in flight", () => {
    recentsState.isLoading = true;
    render(<RecentsPage />);

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(screen.queryByText(/no recent files/i)).not.toBeInTheDocument();
  });

  it("keeps the time-bucketed rows when a background refresh fails", () => {
    recentsState.items = [FILE];
    recentsState.error = new Error("poll failed");
    render(<RecentsPage />);

    expect(screen.getByText("notes.md")).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
